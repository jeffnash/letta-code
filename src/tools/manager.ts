import type Letta from "@letta-ai/letta-client";
import {
  AuthenticationError,
  PermissionDeniedError,
} from "@letta-ai/letta-client";
import { createHash } from "crypto";
import { getDisplayableToolReturn } from "../agent/approval-execution";
import { getModelInfo } from "../agent/model";
import { getAllSubagentConfigs } from "../agent/subagents";
import { INTERRUPTED_BY_USER } from "../constants";
import { runPostToolUseHooks, runPreToolUseHooks } from "../hooks";
import { telemetry } from "../telemetry";
import { TOOL_DEFINITIONS, type ToolName } from "./toolDefinitions";

export const TOOL_NAMES = Object.keys(TOOL_DEFINITIONS) as ToolName[];
const STREAMING_SHELL_TOOLS = new Set([
  "Bash",
  "shell_command",
  "ShellCommand",
  "shell",
  "Shell",
  "run_shell_command",
  "RunShellCommand",
]);

// Maps internal tool names to server/model-facing tool names
// This allows us to have multiple implementations (e.g., write_file_gemini, Write from Anthropic)
// that map to the same server tool name since only one toolset is active at a time
const TOOL_NAME_MAPPINGS: Partial<Record<ToolName, string>> = {
  // Gemini tools - map to their original Gemini CLI names
  glob_gemini: "glob",
  write_todos: "write_todos",
  write_file_gemini: "write_file",
  replace: "replace",
  search_file_content: "search_file_content",
  read_many_files: "read_many_files",
  read_file_gemini: "read_file",
  list_directory: "list_directory",
  run_shell_command: "run_shell_command",
};

/**
 * Get the server-facing name for a tool (maps internal names to what the model sees)
 */
export function getServerToolName(internalName: string): string {
  return TOOL_NAME_MAPPINGS[internalName as ToolName] || internalName;
}

/**
 * Get the internal tool name from a server-facing name
 * Used when the server sends back tool calls/approvals with server names
 */
export function getInternalToolName(serverName: string): string {
  // Build reverse mapping
  for (const [internal, server] of Object.entries(TOOL_NAME_MAPPINGS)) {
    if (server === serverName) {
      return internal;
    }
  }
  // If not in mapping, the server name is the internal name
  return serverName;
}

export const ANTHROPIC_DEFAULT_TOOLS: ToolName[] = [
  "AskUserQuestion",
  "Bash",
  "BashOutput",
  "Edit",
  "EnterPlanMode",
  "ExitPlanMode",
  "Glob",
  "Grep",
  "KillBash",
  // "MultiEdit",
  // "LS",
  "Read",
  "Skill",
  "Task",
  "TodoWrite",
  "Write",
];

export const OPENAI_DEFAULT_TOOLS: ToolName[] = [
  "shell_command",
  "shell",
  "read_file",
  "list_dir",
  "grep_files",
  "apply_patch",
  "update_plan",
  "view_image",
  "Skill",
  "Task",
];

export const GEMINI_DEFAULT_TOOLS: ToolName[] = [
  "run_shell_command",
  "read_file_gemini",
  "list_directory",
  "glob_gemini",
  "search_file_content",
  "replace",
  "write_file_gemini",
  "write_todos",
  "read_many_files",
  "Skill",
  "Task",
];

// PascalCase toolsets (codex-2 and gemini-2) for consistency with Skill tool naming
export const OPENAI_PASCAL_TOOLS: ToolName[] = [
  // Additional Letta Code tools
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "Task",
  "Skill",
  // Standard Codex tools
  "ShellCommand",
  "Shell",
  "ReadFile",
  "view_image",
  "ListDir",
  "GrepFiles",
  "ApplyPatch",
  "UpdatePlan",
];

export const GEMINI_PASCAL_TOOLS: ToolName[] = [
  // Additional Letta Code tools
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "Skill",
  "Task",
  // Standard Gemini tools
  "RunShellCommand",
  "ReadFileGemini",
  "ListDirectory",
  "GlobGemini",
  "SearchFileContent",
  "Replace",
  "WriteFileGemini",
  "WriteTodos",
  "ReadManyFiles",
];

// Tool permissions configuration
const TOOL_PERMISSIONS: Record<ToolName, { requiresApproval: boolean }> = {
  AskUserQuestion: { requiresApproval: true },
  Bash: { requiresApproval: true },
  BashOutput: { requiresApproval: false },
  Edit: { requiresApproval: true },
  EnterPlanMode: { requiresApproval: true },
  ExitPlanMode: { requiresApproval: false },
  Glob: { requiresApproval: false },
  Grep: { requiresApproval: false },
  KillBash: { requiresApproval: true },
  LS: { requiresApproval: false },
  MultiEdit: { requiresApproval: true },
  Read: { requiresApproval: false },
  view_image: { requiresApproval: false },
  ReadLSP: { requiresApproval: false },
  Skill: { requiresApproval: false },
  Task: { requiresApproval: true },
  TodoWrite: { requiresApproval: false },
  Write: { requiresApproval: true },
  shell_command: { requiresApproval: true },
  shell: { requiresApproval: true },
  read_file: { requiresApproval: false },
  list_dir: { requiresApproval: false },
  grep_files: { requiresApproval: false },
  apply_patch: { requiresApproval: true },
  update_plan: { requiresApproval: false },
  // Gemini toolset
  glob_gemini: { requiresApproval: false },
  list_directory: { requiresApproval: false },
  read_file_gemini: { requiresApproval: false },
  read_many_files: { requiresApproval: false },
  replace: { requiresApproval: true },
  run_shell_command: { requiresApproval: true },
  search_file_content: { requiresApproval: false },
  write_todos: { requiresApproval: false },
  write_file_gemini: { requiresApproval: true },
  // Codex-2 toolset (PascalCase)
  ShellCommand: { requiresApproval: true },
  Shell: { requiresApproval: true },
  ReadFile: { requiresApproval: false },
  ListDir: { requiresApproval: false },
  GrepFiles: { requiresApproval: false },
  ApplyPatch: { requiresApproval: true },
  UpdatePlan: { requiresApproval: false },
  // Gemini-2 toolset (PascalCase)
  RunShellCommand: { requiresApproval: true },
  ReadFileGemini: { requiresApproval: false },
  ListDirectory: { requiresApproval: false },
  GlobGemini: { requiresApproval: false },
  SearchFileContent: { requiresApproval: false },
  Replace: { requiresApproval: true },
  WriteFileGemini: { requiresApproval: true },
  WriteTodos: { requiresApproval: false },
  ReadManyFiles: { requiresApproval: false },
};

interface JsonSchema {
  properties?: Record<string, JsonSchema>;
  required?: string[];
  [key: string]: unknown;
}

type ToolArgs = Record<string, unknown>;

interface ToolSchema {
  name: string;
  description: string;
  input_schema: JsonSchema;
}

interface ToolDefinition {
  schema: ToolSchema;
  fn: (args: ToolArgs) => Promise<unknown>;
}

import type {
  ImageContent,
  TextContent,
} from "@letta-ai/letta-client/resources/agents/messages";

// Tool return content can be a string or array of text/image content parts
export type ToolReturnContent = string | Array<TextContent | ImageContent>;

export type ToolExecutionResult = {
  toolReturn: ToolReturnContent;
  status: "success" | "error";
  stdout?: string[];
  stderr?: string[];
};

type ToolRegistry = Map<string, ToolDefinition>;

// Use globalThis to ensure singleton across bundle duplicates
// This prevents Bun's bundler from creating duplicate instances
const REGISTRY_KEY = Symbol.for("@letta/toolRegistry");
const SWITCH_LOCK_KEY = Symbol.for("@letta/toolSwitchLock");

interface SwitchLockState {
  promise: Promise<void> | null;
  resolve: (() => void) | null;
  refCount: number; // Ref-counted to handle overlapping switches
}

type GlobalWithToolState = typeof globalThis & {
  [REGISTRY_KEY]?: ToolRegistry;
  [SWITCH_LOCK_KEY]?: SwitchLockState;
};

function getRegistry(): ToolRegistry {
  const global = globalThis as GlobalWithToolState;
  if (!global[REGISTRY_KEY]) {
    global[REGISTRY_KEY] = new Map();
  }
  return global[REGISTRY_KEY];
}

function getSwitchLock(): SwitchLockState {
  const global = globalThis as GlobalWithToolState;
  if (!global[SWITCH_LOCK_KEY]) {
    global[SWITCH_LOCK_KEY] = { promise: null, resolve: null, refCount: 0 };
  }
  return global[SWITCH_LOCK_KEY];
}

const toolRegistry = getRegistry();

/**
 * Acquires the toolset switch lock. Call before starting async tool loading.
 * Ref-counted: multiple overlapping switches will keep the lock held until all complete.
 * Any calls to waitForToolsetReady() will block until all switches finish.
 */
function acquireSwitchLock(): void {
  const lock = getSwitchLock();
  lock.refCount++;

  // Only create a new promise if this is the first acquirer
  if (lock.refCount === 1) {
    lock.promise = new Promise((resolve) => {
      lock.resolve = resolve;
    });
  }
}

/**
 * Releases the toolset switch lock. Call after atomic registry swap completes.
 * Only actually releases when all acquirers have released (ref-count drops to 0).
 */
function releaseSwitchLock(): void {
  const lock = getSwitchLock();

  if (lock.refCount > 0) {
    lock.refCount--;
  }

  // Only resolve when all switches are done
  if (lock.refCount === 0 && lock.resolve) {
    lock.resolve();
    lock.promise = null;
    lock.resolve = null;
  }
}

/**
 * Waits for any in-progress toolset switch to complete.
 * Call this before reading from the registry to ensure you get the final toolset.
 * Returns immediately if no switch is in progress.
 */
export async function waitForToolsetReady(): Promise<void> {
  const lock = getSwitchLock();
  if (lock.promise) {
    await lock.promise;
  }
}

/**
 * Checks if a toolset switch is currently in progress.
 * Useful for synchronous checks where awaiting isn't possible.
 */
export function isToolsetSwitchInProgress(): boolean {
  return getSwitchLock().refCount > 0;
}

/**
 * Resolve a server/visible tool name to an internal tool name
 * based on the currently loaded toolset.
 *
 * - If a tool with the exact name is loaded, prefer that.
 * - Otherwise, fall back to the alias mapping used for Gemini tools.
 * - Returns undefined if no matching tool is loaded.
 */
function resolveInternalToolName(name: string): string | undefined {
  if (toolRegistry.has(name)) {
    return name;
  }

  const internalName = getInternalToolName(name);
  if (toolRegistry.has(internalName)) {
    return internalName;
  }

  return undefined;
}

/**
 * ClientTool interface matching the Letta SDK's expected format.
 * Used when passing client-side tools via the client_tools field.
 */
export interface ClientTool {
  name: string;
  description?: string | null;
  parameters?: { [key: string]: unknown } | null;
}

/**
 * Get all loaded tools in the format expected by the Letta API's client_tools field.
 * Maps internal tool names to server-facing names for proper tool invocation.
 * Tools are sorted alphabetically by server name for deterministic ordering (required for prompt caching).
 */
export function getClientToolsFromRegistry(): ClientTool[] {
  return Array.from(toolRegistry.entries())
    .map(([name, tool]) => {
      const serverName = getServerToolName(name);
      return {
        name: serverName,
        description: tool.schema.description,
        parameters: tool.schema.input_schema,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Get permissions for a specific tool.
 * @param toolName - The name of the tool
 * @returns Tool permissions object with requiresApproval flag
 */
export function getToolPermissions(toolName: string) {
  return TOOL_PERMISSIONS[toolName as ToolName] || { requiresApproval: false };
}

/**
 * Check if a tool requires approval before execution.
 * @param toolName - The name of the tool
 * @returns true if the tool requires approval, false otherwise
 * @deprecated Use checkToolPermission instead for full permission system support
 */
export function requiresApproval(toolName: string): boolean {
  return TOOL_PERMISSIONS[toolName as ToolName]?.requiresApproval ?? false;
}

/**
 * Check permission for a tool execution using the full permission system.
 * @param toolName - Name of the tool
 * @param toolArgs - Tool arguments
 * @param workingDirectory - Current working directory (defaults to process.cwd())
 * @returns Permission decision: "allow", "deny", or "ask"
 */
export async function checkToolPermission(
  toolName: string,
  toolArgs: ToolArgs,
  workingDirectory: string = process.cwd(),
): Promise<{
  decision: "allow" | "deny" | "ask";
  matchedRule?: string;
  reason?: string;
}> {
  const { checkPermissionWithHooks } = await import("../permissions/checker");
  const { loadPermissions } = await import("../permissions/loader");

  const permissions = await loadPermissions(workingDirectory);
  return checkPermissionWithHooks(
    toolName,
    toolArgs,
    permissions,
    workingDirectory,
  );
}

/**
 * Save a permission rule to settings
 * @param rule - Permission rule (e.g., "Read(src/**)")
 * @param ruleType - Type of rule ("allow", "deny", or "ask")
 * @param scope - Where to save ("project", "local", "user", or "session")
 * @param workingDirectory - Current working directory
 */
export async function savePermissionRule(
  rule: string,
  ruleType: "allow" | "deny" | "ask",
  scope: "project" | "local" | "user" | "session",
  workingDirectory: string = process.cwd(),
): Promise<void> {
  // Handle session-only permissions
  if (scope === "session") {
    const { sessionPermissions } = await import("../permissions/session");
    sessionPermissions.addRule(rule, ruleType);
    return;
  }

  // Handle persisted permissions
  const { savePermissionRule: save } = await import("../permissions/loader");
  await save(rule, ruleType, scope, workingDirectory);
}

/**
 * Analyze approval context for a tool execution
 * @param toolName - Name of the tool
 * @param toolArgs - Tool arguments
 * @param workingDirectory - Current working directory
 * @returns Approval context with recommended rule and button text
 */
export async function analyzeToolApproval(
  toolName: string,
  toolArgs: ToolArgs,
  workingDirectory: string = process.cwd(),
): Promise<import("../permissions/analyzer").ApprovalContext> {
  const { analyzeApprovalContext } = await import("../permissions/analyzer");
  return analyzeApprovalContext(toolName, toolArgs, workingDirectory);
}

/**
 * Atomically replaces the tool registry contents.
 * This ensures no intermediate state where registry is empty or partial.
 *
 * @param newTools - Map of tools to replace the registry with
 */
function replaceRegistry(newTools: ToolRegistry): void {
  // Single sync block - no awaits, no yields, no interleaving possible
  toolRegistry.clear();
  for (const [key, value] of newTools) {
    toolRegistry.set(key, value);
  }
}

/**
 * Loads specific tools by name into the registry.
 * Used when resuming an agent to load only the tools attached to that agent.
 *
 * Acquires the toolset switch lock during loading to prevent message sends from
 * reading stale tools. Callers should use waitForToolsetReady() before sending messages.
 *
 * @param toolNames - Array of specific tool names to load
 */
export async function loadSpecificTools(toolNames: string[]): Promise<void> {
  // Acquire lock to signal that a switch is in progress
  acquireSwitchLock();

  try {
    // Import filter once, outside the loop (avoids repeated async yields)
    const { toolFilter } = await import("./filter");

    // Build new registry in a temporary map (all async work happens here)
    const newRegistry: ToolRegistry = new Map();

    for (const name of toolNames) {
      // Skip if tool filter is active and this tool is not enabled
      if (!toolFilter.isEnabled(name)) {
        continue;
      }

      // Map server-facing name to our internal tool name
      const internalName = getInternalToolName(name);

      const definition = TOOL_DEFINITIONS[internalName as ToolName];
      if (!definition) {
        console.warn(
          `Tool ${name} (internal: ${internalName}) not found in definitions, skipping`,
        );
        continue;
      }

      if (!definition.impl) {
        throw new Error(`Tool implementation not found for ${internalName}`);
      }

      const toolSchema: ToolSchema = {
        name: internalName,
        description: definition.description,
        input_schema: definition.schema,
      };

      // Add to temporary registry
      newRegistry.set(internalName, {
        schema: toolSchema,
        fn: definition.impl,
      });
    }

    // Atomic swap - no yields between clear and populate
    replaceRegistry(newRegistry);
  } finally {
    // Always release the lock, even if an error occurred
    releaseSwitchLock();
  }
}

/**
 * Loads all tools defined in TOOL_NAMES and constructs their full schemas + function references.
 * This should be called on program startup.
 * Will error if any expected tool files are missing.
 *
 * Acquires the toolset switch lock during loading to prevent message sends from
 * reading stale tools. Callers should use waitForToolsetReady() before sending messages.
 *
 * @returns Promise that resolves when all tools are loaded
 */
export async function loadTools(modelIdentifier?: string): Promise<void> {
  // Acquire lock to signal that a switch is in progress
  acquireSwitchLock();

  try {
    const { toolFilter } = await import("./filter");

    // Get all subagents (built-in + custom) to inject into Task description
    const allSubagentConfigs = await getAllSubagentConfigs();
    const discoveredSubagents = Object.entries(allSubagentConfigs).map(
      ([name, config]) => ({
        name,
        description: config.description,
        recommendedModel: config.recommendedModel,
      }),
    );
    const filterActive = toolFilter.isActive();

    let baseToolNames: ToolName[];
    if (!filterActive && modelIdentifier && isGeminiModel(modelIdentifier)) {
      baseToolNames = GEMINI_PASCAL_TOOLS;
    } else if (
      !filterActive &&
      modelIdentifier &&
      isOpenAIModel(modelIdentifier)
    ) {
      baseToolNames = OPENAI_PASCAL_TOOLS;
    } else if (!filterActive) {
      baseToolNames = ANTHROPIC_DEFAULT_TOOLS;
    } else {
      // When user explicitly sets --tools, respect that and allow any tool name
      baseToolNames = TOOL_NAMES;
    }

    // Build new registry in a temporary map (all async work happens above)
    const newRegistry: ToolRegistry = new Map();

    for (const name of baseToolNames) {
      if (!toolFilter.isEnabled(name)) {
        continue;
      }

      try {
        const definition = TOOL_DEFINITIONS[name];
        if (!definition) {
          throw new Error(`Missing tool definition for ${name}`);
        }

        if (!definition.impl) {
          throw new Error(`Tool implementation not found for ${name}`);
        }

        // For Task tool, inject discovered subagent descriptions
        let description = definition.description;
        if (name === "Task" && discoveredSubagents.length > 0) {
          description = injectSubagentsIntoTaskDescription(
            description,
            discoveredSubagents,
          );
        }

        const toolSchema: ToolSchema = {
          name,
          description,
          input_schema: definition.schema,
        };

        newRegistry.set(name, {
          schema: toolSchema,
          fn: definition.impl,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : JSON.stringify(error);
        throw new Error(
          `Required tool "${name}" could not be loaded from bundled assets. ${message}`,
        );
      }
    }

    // If LSP is enabled, swap Read with LSP-enhanced version
    if (process.env.LETTA_ENABLE_LSP && newRegistry.has("Read")) {
      const lspDefinition = TOOL_DEFINITIONS.ReadLSP;
      if (lspDefinition) {
        // Replace Read with ReadLSP (but keep the name "Read" for the agent)
        newRegistry.set("Read", {
          schema: {
            name: "Read", // Keep the tool name as "Read" for the agent
            description: lspDefinition.description,
            input_schema: lspDefinition.schema,
          },
          fn: lspDefinition.impl,
        });
      }
    }

    // Atomic swap - no yields between clear and populate
    replaceRegistry(newRegistry);
  } finally {
    // Always release the lock, even if an error occurred
    releaseSwitchLock();
  }
}

/**
 * Check if a model identifier is an OpenAI/GPT-5 model (uses memory_apply_patch, codex toolset)
 */
function isOpenAIModelHandle(handle: string): boolean {
  return (
    handle.startsWith("openai/") ||
    handle.startsWith("cliproxy/gpt-5") ||
    handle.startsWith("cliproxy/copilot-gpt-5") ||
    handle.startsWith("cliproxy/copilot-gpt-4")
  );
}

export function isOpenAIModel(modelIdentifier: string): boolean {
  const info = getModelInfo(modelIdentifier);
  if (info?.handle && typeof info.handle === "string") {
    return isOpenAIModelHandle(info.handle);
  }
  // Fallback: treat raw handle-style identifiers
  return isOpenAIModelHandle(modelIdentifier);
}

/**
 * Check if a model identifier is a Gemini model (uses gemini toolset)
 */
function isGeminiModelHandle(handle: string): boolean {
  return (
    handle.startsWith("google/") ||
    handle.startsWith("google_ai/") ||
    handle.startsWith("cliproxy/gemini-") ||
    handle.startsWith("cliproxy/copilot-gemini-")
  );
}

export function isGeminiModel(modelIdentifier: string): boolean {
  const info = getModelInfo(modelIdentifier);
  if (info?.handle && typeof info.handle === "string") {
    return isGeminiModelHandle(info.handle);
  }
  // Fallback: treat raw handle-style identifiers
  return isGeminiModelHandle(modelIdentifier);
}

/**
 * Inject discovered subagent descriptions into the Task tool description
 */
function injectSubagentsIntoTaskDescription(
  baseDescription: string,
  subagents: Array<{
    name: string;
    description: string;
    recommendedModel: string;
  }>,
): string {
  if (subagents.length === 0) {
    return baseDescription;
  }

  // Build subagents section
  const agentsSection = subagents
    .map((agent) => {
      return `### ${agent.name}
- **Purpose**: ${agent.description}
- **Recommended model**: ${agent.recommendedModel}`;
    })
    .join("\n\n");

  // Insert before ## Usage section
  const usageMarker = "## Usage";
  const usageIndex = baseDescription.indexOf(usageMarker);

  if (usageIndex === -1) {
    // Fallback: append at the end
    return `${baseDescription}\n\n## Available Agents\n\n${agentsSection}`;
  }

  // Insert agents section before ## Usage
  const before = baseDescription.slice(0, usageIndex);
  const after = baseDescription.slice(usageIndex);

  return `${before}## Available Agents\n\n${agentsSection}\n\n${after}`;
}

/**
 * Helper to clip tool return text to a reasonable display size
 * Used by UI components to truncate long responses for display
 */
export function clipToolReturn(
  text: string,
  maxLines: number = 3,
  maxChars: number = 300,
): string {
  if (!text) return text;

  // Don't clip user rejection reasons - they contain important feedback
  // All denials use format: "Error: request to call tool denied. User reason: ..."
  if (text.includes("request to call tool denied")) {
    return text;
  }

  // First apply character limit to avoid extremely long text
  let clipped = text;
  if (text.length > maxChars) {
    clipped = text.slice(0, maxChars);
  }

  // Then split into lines and limit line count
  const lines = clipped.split("\n");
  if (lines.length > maxLines) {
    clipped = lines.slice(0, maxLines).join("\n");
  }

  // Add ellipsis if we truncated
  if (text.length > maxChars || lines.length > maxLines) {
    // Try to break at a word boundary if possible
    const lastSpace = clipped.lastIndexOf(" ");
    if (lastSpace > maxChars * 0.8) {
      clipped = clipped.slice(0, lastSpace);
    }
    clipped += "…";
  }

  return clipped;
}

/**
 * Flattens a tool response to a simple string format.
 * Extracts the actual content from structured responses to match what the LLM expects.
 *
 * @param result - The raw result from a tool execution
 * @returns A flattened string representation of the result
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

/**
 * Check if an array contains multimodal content (text + images)
 */
function isMultimodalContent(
  arr: unknown[],
): arr is Array<TextContent | ImageContent> {
  return arr.every(
    (item) => isRecord(item) && (item.type === "text" || item.type === "image"),
  );
}

/**
 * Calculate the approximate size of multimodal content without creating a full JSON string.
 * For text content, returns text length. For images, returns base64 data length + overhead.
 * This avoids large memory spikes from JSON.stringify on image data.
 */
function calculateMultimodalSize(
  content: Array<TextContent | ImageContent>,
): number {
  let size = 0;
  for (const part of content) {
    if (part.type === "text") {
      size += part.text?.length ?? 0;
    } else if (part.type === "image") {
      // For images, count the source URL/data length
      // Image source can be a URL or base64 data URI
      const source = part.source;
      if (source && typeof source === "object" && "data" in source) {
        // Base64 encoded data
        size += (source.data as string)?.length ?? 0;
      } else if (source && typeof source === "object" && "url" in source) {
        // URL reference
        size += (source.url as string)?.length ?? 0;
      }
      // Add small overhead for JSON structure (type, media_type, etc.)
      size += 100;
    }
  }
  return size;
}

function flattenToolResponse(result: unknown): ToolReturnContent {
  if (result === null || result === undefined) {
    return "";
  }

  if (typeof result === "string") {
    return result;
  }

  if (!isRecord(result)) {
    return JSON.stringify(result);
  }

  if (typeof result.message === "string") {
    return result.message;
  }

  // Check for multimodal content (images) - return as-is without flattening
  if (Array.isArray(result.content) && isMultimodalContent(result.content)) {
    return result.content;
  }

  if (typeof result.content === "string") {
    return result.content;
  }

  if (Array.isArray(result.content)) {
    const textContent = result.content
      .filter(
        (item): item is { type: string; text: string } =>
          isRecord(item) &&
          item.type === "text" &&
          typeof item.text === "string",
      )
      .map((item) => item.text)
      .join("\n");

    if (textContent) {
      return textContent;
    }
  }

  if (typeof result.output === "string") {
    return result.output;
  }

  if (Array.isArray(result.files)) {
    const files = result.files.filter(
      (file): file is string => typeof file === "string",
    );
    if (files.length === 0) {
      return "No files found";
    }
    return `Found ${files.length} file${files.length === 1 ? "" : "s"}\n${files.join("\n")}`;
  }

  if (typeof result.killed === "boolean") {
    return result.killed
      ? "Process killed successfully"
      : "Failed to kill process (may have already exited)";
  }

  if (typeof result.error === "string") {
    return result.error;
  }

  if (Array.isArray(result.todos)) {
    return `Updated ${result.todos.length} todo${result.todos.length !== 1 ? "s" : ""}`;
  }

  return JSON.stringify(result);
}

/**
 * Executes a tool by name with the provided arguments.
 *
 * @param name - The name of the tool to execute
 * @param args - Arguments object to pass to the tool
 * @param options - Optional execution options (abort signal, tool call ID, streaming callback)
 * @returns Promise with the tool's execution result including status and optional stdout/stderr
 */
export async function executeTool(
  name: string,
  args: ToolArgs,
  options?: {
    signal?: AbortSignal;
    toolCallId?: string;
    onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
  },
): Promise<ToolExecutionResult> {
  const internalName = resolveInternalToolName(name);
  if (!internalName) {
    return {
      toolReturn: `Tool not found: ${name}. Available tools: ${Array.from(toolRegistry.keys()).join(", ")}`,
      status: "error",
    };
  }

  const tool = toolRegistry.get(internalName);
  if (!tool) {
    return {
      toolReturn: `Tool not found: ${name}. Available tools: ${Array.from(toolRegistry.keys()).join(", ")}`,
      status: "error",
    };
  }

  const startTime = Date.now();

  // Run PreToolUse hooks - can block tool execution
  const preHookResult = await runPreToolUseHooks(
    internalName,
    args as Record<string, unknown>,
    options?.toolCallId,
  );
  if (preHookResult.blocked) {
    const feedback = preHookResult.feedback.join("\n") || "Blocked by hook";
    return {
      toolReturn: `Error: Tool execution blocked by hook. ${feedback}`,
      status: "error",
    };
  }

  try {
    // Inject options for tools that support them without altering schemas
    let enhancedArgs = args;

    if (STREAMING_SHELL_TOOLS.has(internalName)) {
      if (options?.signal) {
        enhancedArgs = { ...enhancedArgs, signal: options.signal };
      }
      if (options?.onOutput) {
        enhancedArgs = { ...enhancedArgs, onOutput: options.onOutput };
      }
    }

    // Inject toolCallId and abort signal for Task tool
    if (internalName === "Task") {
      if (options?.toolCallId) {
        enhancedArgs = { ...enhancedArgs, toolCallId: options.toolCallId };
      }
      if (options?.signal) {
        enhancedArgs = { ...enhancedArgs, signal: options.signal };
      }
    }

    const result = await tool.fn(enhancedArgs);
    const duration = Date.now() - startTime;

    // Extract stdout/stderr if present (for bash tools)
    const recordResult = isRecord(result) ? result : undefined;
    const stdoutValue = recordResult?.stdout;
    const stderrValue = recordResult?.stderr;
    const stdout = isStringArray(stdoutValue) ? stdoutValue : undefined;
    const stderr = isStringArray(stderrValue) ? stderrValue : undefined;

    // Check if tool returned a status (e.g., Bash returns status: "error" on abort)
    const toolStatus = recordResult?.status === "error" ? "error" : "success";

    // Flatten the response to plain text
    const flattenedResponse = flattenToolResponse(result);

    // Track tool usage (calculate size for multimodal content without JSON.stringify)
    const responseSize =
      typeof flattenedResponse === "string"
        ? flattenedResponse.length
        : calculateMultimodalSize(flattenedResponse);
    telemetry.trackToolUsage(
      internalName,
      toolStatus === "success",
      duration,
      responseSize,
      toolStatus === "error" ? "tool_error" : undefined,
      stderr ? stderr.join("\n") : undefined,
    );

    // Run PostToolUse hooks (async, non-blocking)
    runPostToolUseHooks(
      internalName,
      args as Record<string, unknown>,
      {
        status: toolStatus,
        output: getDisplayableToolReturn(flattenedResponse),
      },
      options?.toolCallId,
    ).catch(() => {
      // Silently ignore hook errors - don't affect tool execution
    });

    // Return the full response (truncation happens in UI layer only)
    return {
      toolReturn: flattenedResponse,
      status: toolStatus,
      ...(stdout && { stdout }),
      ...(stderr && { stderr }),
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const isAbort =
      error instanceof Error &&
      (error.name === "AbortError" ||
        error.message === "The operation was aborted" ||
        // node:child_process AbortError may include code/message variants
        ("code" in error && error.code === "ABORT_ERR"));
    const errorType = isAbort
      ? "abort"
      : error instanceof Error
        ? error.name
        : "unknown";
    const errorMessage = isAbort
      ? INTERRUPTED_BY_USER
      : error instanceof Error
        ? error.message
        : String(error);

    // Track tool usage error
    telemetry.trackToolUsage(
      internalName,
      false,
      duration,
      errorMessage.length,
      errorType,
      errorMessage,
    );

    // Run PostToolUse hooks for error case (async, non-blocking)
    runPostToolUseHooks(
      internalName,
      args as Record<string, unknown>,
      { status: "error", output: errorMessage },
      options?.toolCallId,
    ).catch(() => {
      // Silently ignore hook errors
    });

    // Don't console.error here - it pollutes the TUI
    // The error message is already returned in toolReturn
    return {
      toolReturn: errorMessage,
      status: "error",
    };
  }
}

/**
 * Gets all loaded tool names (for passing to Letta agent creation).
 *
 * @returns Array of tool names
 */
export function getToolNames(): string[] {
  return Array.from(toolRegistry.keys());
}

/**
 * Returns all Letta Code tool names known to this build, regardless of what is currently loaded.
 * Useful for unlinking/removing tools when switching providers/models.
 */
export function getAllLettaToolNames(): string[] {
  return [...TOOL_NAMES];
}

/**
 * Gets all loaded tool schemas (for inspection/debugging).
 *
 * @returns Array of tool schemas
 */
export function getToolSchemas(): ToolSchema[] {
  return Array.from(toolRegistry.values()).map((tool) => tool.schema);
}

/**
 * Gets a single tool's schema by name.
 *
 * @param name - The tool name
 * @returns The tool schema or undefined if not found
 */
export function getToolSchema(name: string): ToolSchema | undefined {
  const internalName = resolveInternalToolName(name);
  if (!internalName) return undefined;
  return toolRegistry.get(internalName)?.schema;
}

/**
 * Clears the tool registry (useful for testing).
 */
export function clearTools(): void {
  toolRegistry.clear();
}

/**
 * Sanitize a parameter name to be a valid Python identifier.
 * Handles parameters like -B, -A, -C in Grep schema.
 */
function sanitizePythonParamName(name: string): string {
  let sanitized = name.replace(/^-+/, "_").replace(/[^a-zA-Z0-9_]/g, "_");
  if (/^[0-9]/.test(sanitized)) {
    sanitized = "_" + sanitized;
  }
  return sanitized || "_param";
}

/**
 * Generate a Python stub for a tool that will be executed client-side.
 */
function generatePythonStub(
  name: string,
  _description: string,
  schema: JsonSchema,
): string {
  const params = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const required = schema.required ?? [];

  const allKeys = Object.keys(params);
  const requiredParams = allKeys.filter((key) => required.includes(key));
  const optionalParams = allKeys.filter((key) => !required.includes(key));

  const paramList = [
    ...requiredParams.map(sanitizePythonParamName),
    ...optionalParams.map((key) => `${sanitizePythonParamName(key)}=None`),
  ].join(", ");

  return `def ${name}(${paramList}):
    """Stub method. This tool is executed client-side via the approval flow.
    """
    raise Exception("This is a stub tool. Execution should happen on client.")  
`;
}

/**
 * Upsert all loaded tools to the Letta server.
 */
export async function upsertToolsToServer(client: Letta): Promise<void> {
  const OPERATION_TIMEOUT = 20000;
  const MAX_TOTAL_TIME = 30000;
  const startTime = Date.now();

  async function attemptUpsert(retryCount: number = 0): Promise<void> {
    const attemptStartTime = Date.now();

    if (Date.now() - startTime > MAX_TOTAL_TIME) {
      throw new Error(
        "Tool upserting exceeded maximum time limit (30s). Please check your network connection and try again.",
      );
    }

    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(
            new Error(
              `Tool upsert operation timed out (${OPERATION_TIMEOUT / 1000}s)`,
            ),
          );
        }, OPERATION_TIMEOUT);
      });

      const upsertPromise = Promise.all(
        Array.from(toolRegistry.entries()).map(async ([name, tool]) => {
          const serverName = TOOL_NAME_MAPPINGS[name as ToolName] || name;

          const pythonStub = generatePythonStub(
            serverName,
            tool.schema.description,
            tool.schema.input_schema,
          );

          const fullJsonSchema = {
            name: serverName,
            description: tool.schema.description,
            parameters: tool.schema.input_schema,
          };

          await client.tools.upsert({
            default_requires_approval: true,
            source_code: pythonStub,
            json_schema: fullJsonSchema,
          });
        }),
      );

      await Promise.race([upsertPromise, timeoutPromise]);
      return;
    } catch (error) {
      const elapsed = Date.now() - attemptStartTime;
      const totalElapsed = Date.now() - startTime;

      if (
        error instanceof AuthenticationError ||
        error instanceof PermissionDeniedError
      ) {
        throw new Error(
          `Authentication failed. Please check your LETTA_API_KEY.\n` +
            `Run 'rm ~/.letta/settings.json' and restart to re-authenticate.\n` +
            `Original error: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (totalElapsed < MAX_TOTAL_TIME) {
        const backoffDelay = Math.min(1000 * 2 ** retryCount, 5000);
        const remainingTime = MAX_TOTAL_TIME - totalElapsed;

        console.error(
          `Tool upsert attempt ${retryCount + 1} failed after ${elapsed}ms. Retrying in ${backoffDelay}ms... (${Math.round(remainingTime / 1000)}s remaining)`,
        );
        console.error(
          `Error: ${error instanceof Error ? error.message : String(error)}`,
        );

        await new Promise((resolve) => setTimeout(resolve, backoffDelay));
        return attemptUpsert(retryCount + 1);
      }

      throw error;
    }
  }

  await attemptUpsert();
}

/**
 * Compute a hash of all currently loaded tools for cache invalidation.
 */
export function computeToolsHash(): string {
  const toolData = Array.from(toolRegistry.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, tool]) => ({
      name,
      serverName: getServerToolName(name),
      schema: tool.schema,
    }));

  return createHash("sha256")
    .update(JSON.stringify(toolData))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Upserts tools only if the tool definitions have changed since last upsert.
 */
export async function upsertToolsIfNeeded(
  client: Letta,
  serverUrl: string,
): Promise<boolean> {
  const currentHash = computeToolsHash();

  const { settingsManager } = await import("../settings-manager");
  const cachedHashes = settingsManager.getSetting("toolUpsertHashes") || {};

  if (cachedHashes[serverUrl] === currentHash) {
    return false;
  }

  await upsertToolsToServer(client);

  settingsManager.updateSettings({
    toolUpsertHashes: { ...cachedHashes, [serverUrl]: currentHash },
  });

  return true;
}

/**
 * Force upsert tools by clearing the hash cache for the server.
 */
export async function forceUpsertTools(
  client: Letta,
  serverUrl: string,
): Promise<void> {
  const { settingsManager } = await import("../settings-manager");
  const cachedHashes = settingsManager.getSetting("toolUpsertHashes") || {};

  delete cachedHashes[serverUrl];
  settingsManager.updateSettings({ toolUpsertHashes: cachedHashes });

  await upsertToolsIfNeeded(client, serverUrl);
}

/**
 * Clears the tool registry with lock protection.
 * Acquires the switch lock, clears the registry, then releases the lock.
 * This ensures sendMessageStream() waits for the clear to complete.
 */
export function clearToolsWithLock(): void {
  acquireSwitchLock();
  try {
    toolRegistry.clear();
  } finally {
    releaseSwitchLock();
  }
}
