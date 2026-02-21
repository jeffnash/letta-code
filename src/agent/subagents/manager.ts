/**
 * Subagent manager for spawning and coordinating subagents
 *
 * This module handles:
 * - Spawning subagents via letta CLI in headless mode
 * - Executing subagents and collecting final reports
 * - Managing parallel subagent execution
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  addToolCall,
  updateToolCall,
  updateSubagent,
} from "../../cli/helpers/subagentState.js";
import {
  INTERRUPTED_BY_USER,
  SYSTEM_REMINDER_CLOSE,
  SYSTEM_REMINDER_OPEN,
} from "../../constants";
import { cliPermissions } from "../../permissions/cli";
import { permissionMode } from "../../permissions/mode";
import { sessionPermissions } from "../../permissions/session";
import { settingsManager } from "../../settings-manager";

import { getErrorMessage } from "../../utils/error";
import { getAvailableModelHandles } from "../available-models";
import { getClient } from "../client";
import { getCurrentAgentId } from "../context";
import { getDefaultModel, resolveModel, resolveModelAsync } from "../model";
import { SKILLS_DIR } from "../skills";

import { getAllSubagentConfigs, type SubagentConfig } from ".";

// ============================================================================
// Types
// ============================================================================

/**
 * Response from the server's model selector resolver
 */
interface ModelSelectorResponse {
  resolved_handle: string;
  expansion_chain: string[];
}

/**
 * Subagent execution result
 */
export interface SubagentResult {
  agentId: string;
  conversationId?: string;
  report: string;
  success: boolean;
  error?: string;
  totalTokens?: number;
}

export interface SubagentProgressUpdate {
  message: string;
  agentId?: string;
  conversationId?: string;
  toolCallId?: string;
  toolName?: string;
}

/**
 * State tracked during subagent execution
 */
interface ExecutionState {
  agentId: string | null;
  conversationId: string | null;
  finalResult: string | null;
  finalError: string | null;
  resultStats: { durationMs: number; totalTokens: number } | null;
  displayedToolCalls: Set<string>;
  pendingToolCalls: Map<string, { name: string; args: string }>;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get the primary agent's model handle.
 * Fetches from API and resolves to a concrete handle when possible.
 */
function getModelHandleFromAgent(agent: {
  llm_config?: { model_endpoint_type?: string | null; model?: string | null };
}): string | null {
  const endpoint = agent.llm_config?.model_endpoint_type;
  const model = agent.llm_config?.model;
  if (endpoint && model) {
    return `${endpoint}/${model}`;
  }
  return model || null;
}

export async function getPrimaryAgentModelHandle(): Promise<
  string | undefined
> {
  try {
    const agentId = getCurrentAgentId();
    const client = await getClient();
    const agent = await client.agents.retrieve(agentId);
    return getModelHandleFromAgent(agent) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Handle tool_call_message chunks so tool usage is visible even when
 * approvals are bypassed/auto-handled by permissions.
 */
function handleToolCallMessageEvent(
  event: { tool_calls?: unknown[]; tool_call?: unknown },
  state: ExecutionState,
  subagentId: string,
  onProgress?: (update: SubagentProgressUpdate) => void,
): void {
  const toolCalls = Array.isArray(event.tool_calls)
    ? event.tool_calls
    : event.tool_call
      ? [event.tool_call]
      : [];

  for (const toolCall of toolCalls) {
    const tc = toolCall as {
      tool_call_id?: string;
      name?: string;
      arguments?: string;
    };
    const id = tc.tool_call_id;
    if (!id) continue;

    const prev = state.pendingToolCalls.get(id) || { name: "", args: "" };
    const name = tc.name || prev.name;
    const args = prev.args + (tc.arguments || "");
    state.pendingToolCalls.set(id, { name, args });

    const normalizedArgs = args || "{}";

    // Tool call args may stream in multiple chunks; refresh already-recorded calls.
    if (state.displayedToolCalls.has(id)) {
      updateToolCall(subagentId, id, {
        ...(name ? { name } : {}),
        args: normalizedArgs,
      });
      continue;
    }

    if (name) {
      recordToolCall(
        subagentId,
        id,
        name,
        normalizedArgs,
        state.displayedToolCalls,
        onProgress,
      );
    }
  }
}

/**
 * Check if an error message indicates an unsupported provider
 */
function isProviderNotSupportedError(errorOutput: string): boolean {
  return (
    errorOutput.includes("Provider") &&
    errorOutput.includes("is not supported") &&
    errorOutput.includes("supported providers:")
  );
}

/**
 * Check if an error likely came from transient transport/network instability.
 */
function isTransientTransportError(errorOutput: string): boolean {
  const lowerError = errorOutput.toLowerCase();
  return (
    lowerError.includes("readerror") ||
    lowerError.includes("httpx.readerror") ||
    lowerError.includes("httpcore.readerror") ||
    lowerError.includes("connection reset") ||
    lowerError.includes("connection aborted") ||
    lowerError.includes("broken pipe") ||
    lowerError.includes("timed out") ||
    lowerError.includes("timeout") ||
    lowerError.includes("failed to connect") ||
    lowerError.includes("econnreset") ||
    lowerError.includes("econnrefused") ||
    lowerError.includes("socket hang up") ||
    lowerError.includes("stream was cancelled") ||
    lowerError.includes("stream ended")
  );
}

const MAX_TRANSIENT_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 800;
const RETRY_MAX_DELAY_MS = 8_000;

function computeRetryDelayMs(attempt: number): number {
  const base = Math.min(
    RETRY_MAX_DELAY_MS,
    RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1),
  );
  // Add bounded jitter to avoid synchronized retry bursts.
  const jitter = Math.floor(Math.random() * 300);
  return Math.min(RETRY_MAX_DELAY_MS, base + jitter);
}

async function waitForRetryDelay(
  delayMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) {
    return false;
  }

  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });

  return !signal?.aborted;
}

function isRetryableSubagentError(errorMessage: string | undefined): boolean {
  if (!errorMessage) return false;
  return isRateLimitError(errorMessage) || isTransientTransportError(errorMessage);
}

const BYOK_PROVIDER_TO_BASE: Record<string, string> = {
  "lc-anthropic": "anthropic",
  "lc-openai": "openai",
  "lc-zai": "zai",
  "lc-gemini": "google_ai",
  "lc-openrouter": "openrouter",
  "lc-minimax": "minimax",
  "lc-bedrock": "bedrock",
  "chatgpt-plus-pro": "chatgpt-plus-pro",
};

function getProviderPrefix(handle: string): string | null {
  const slashIndex = handle.indexOf("/");
  if (slashIndex === -1) return null;
  return handle.slice(0, slashIndex);
}

function swapProviderPrefix(
  parentHandle: string,
  recommendedHandle: string,
): string | null {
  const parentProvider = getProviderPrefix(parentHandle);
  if (!parentProvider) return null;

  const baseProvider = BYOK_PROVIDER_TO_BASE[parentProvider];
  if (!baseProvider) return null;

  const recommendedProvider = getProviderPrefix(recommendedHandle);
  if (!recommendedProvider || recommendedProvider !== baseProvider) return null;

  const modelPortion = recommendedHandle.slice(recommendedProvider.length + 1);
  return `${parentProvider}/${modelPortion}`;
}

export async function resolveSubagentModel(options: {
  userModel?: string;
  recommendedModel?: string;
  parentModelHandle?: string | null;
  availableHandles?: Set<string>;
}): Promise<string | null> {
  const { userModel, recommendedModel, parentModelHandle } = options;

  if (userModel) return userModel;

  let recommendedHandle: string | null = null;
  if (recommendedModel && recommendedModel !== "inherit") {
    recommendedHandle = resolveModel(recommendedModel);
  }

  let availableHandles: Set<string> | null = options.availableHandles ?? null;
  const isAvailable = async (handle: string): Promise<boolean> => {
    try {
      if (!availableHandles) {
        const result = await getAvailableModelHandles();
        availableHandles = result.handles;
      }
      return availableHandles.has(handle);
    } catch {
      return false;
    }
  };

  if (parentModelHandle) {
    const parentProvider = getProviderPrefix(parentModelHandle);
    const parentBaseProvider = parentProvider
      ? BYOK_PROVIDER_TO_BASE[parentProvider]
      : null;
    const parentIsByok = !!parentBaseProvider;

    if (recommendedHandle) {
      const recommendedProvider = getProviderPrefix(recommendedHandle);

      if (parentIsByok) {
        if (recommendedProvider === parentProvider) {
          if (await isAvailable(recommendedHandle)) {
            return recommendedHandle;
          }
        } else {
          const swapped = swapProviderPrefix(
            parentModelHandle,
            recommendedHandle,
          );
          if (swapped && (await isAvailable(swapped))) {
            return swapped;
          }
        }

        return parentModelHandle;
      }

      if (await isAvailable(recommendedHandle)) {
        return recommendedHandle;
      }
    }

    return parentModelHandle;
  }

  if (recommendedHandle && (await isAvailable(recommendedHandle))) {
    return recommendedHandle;
  }

  return recommendedHandle;
}

/**
 * Check if an error message indicates an unknown/unavailable model
 */
function isUnknownModelError(errorOutput: string): boolean {
  return (
    errorOutput.includes("Unknown model") ||
    errorOutput.includes("Error: Unknown model")
  );
}

/**
 * Check if an error message indicates a rate limit or temporary unavailability
 */
function isRateLimitError(errorOutput: string): boolean {
  const lowerError = errorOutput.toLowerCase();
  return (
    lowerError.includes("rate limit") ||
    lowerError.includes("rate_limit") ||
    lowerError.includes("ratelimit") ||
    lowerError.includes("too many requests") ||
    lowerError.includes("429") ||
    lowerError.includes("temporarily unavailable") ||
    lowerError.includes("temporarily disabled") ||
    lowerError.includes("model is currently unavailable") ||
    lowerError.includes("capacity") ||
    lowerError.includes("overloaded")
  );
}

/**
 * Record a tool call to the state store
 */
function recordToolCall(
  subagentId: string,
  toolCallId: string,
  toolName: string,
  toolArgs: string,
  displayedToolCalls: Set<string>,
  onProgress?: (update: SubagentProgressUpdate) => void,
): void {
  if (!toolCallId || !toolName || displayedToolCalls.has(toolCallId)) return;
  displayedToolCalls.add(toolCallId);
  addToolCall(subagentId, toolCallId, toolName, toolArgs);
  onProgress?.({
    message: `[tool] ${toolName}`,
    toolCallId,
    toolName,
  });
}

/**
 * Handle an init event from the subagent stream
 */
function handleInitEvent(
  event: { agent_id?: string; conversation_id?: string },
  state: ExecutionState,
  agentDisplayURL: string,
  subagentId: string,
  onProgress?: (update: SubagentProgressUpdate) => void,
): void {
  if (event.agent_id) {
    state.agentId = event.agent_id;
    const agentURL = `${agentDisplayURL}/agents/${event.agent_id}`;
    updateSubagent(subagentId, { agentURL, agentId: event.agent_id });
  }
  if (event.conversation_id) {
    state.conversationId = event.conversation_id;
    updateSubagent(subagentId, { conversationId: event.conversation_id });
  }

  if (event.agent_id || event.conversation_id) {
    const parts = [
      event.agent_id ? `agent_id=${event.agent_id}` : undefined,
      event.conversation_id
        ? `conversation_id=${event.conversation_id}`
        : undefined,
    ]
      .filter(Boolean)
      .join(" ");
    if (parts) {
      onProgress?.({
        message: `[ids] ${parts}`,
        agentId: event.agent_id,
        conversationId: event.conversation_id,
      });
    }
  }
}

/**
 * Handle an approval request message event
 */
function handleApprovalRequestEvent(
  event: { tool_calls?: unknown[]; tool_call?: unknown },
  state: ExecutionState,
): void {
  const toolCalls = Array.isArray(event.tool_calls)
    ? event.tool_calls
    : event.tool_call
      ? [event.tool_call]
      : [];

  for (const toolCall of toolCalls) {
    const tc = toolCall as {
      tool_call_id?: string;
      name?: string;
      arguments?: string;
    };
    const id = tc.tool_call_id;
    if (!id) continue;

    const prev = state.pendingToolCalls.get(id) || { name: "", args: "" };
    const name = tc.name || prev.name;
    const args = prev.args + (tc.arguments || "");
    state.pendingToolCalls.set(id, { name, args });
  }
}

/**
 * Handle an auto_approval event
 */
function handleAutoApprovalEvent(
  event: {
    tool_call?: { tool_call_id?: string; name?: string; arguments?: string };
  },
  state: ExecutionState,
  subagentId: string,
  onProgress?: (update: SubagentProgressUpdate) => void,
): void {
  const tc = event.tool_call;
  if (!tc) return;
  const { tool_call_id, name, arguments: tool_args = "{}" } = tc;
  if (tool_call_id && name) {
    recordToolCall(
      subagentId,
      tool_call_id,
      name,
      tool_args,
      state.displayedToolCalls,
      onProgress,
    );
  }
}

/**
 * Handle a result event
 */
function handleResultEvent(
  event: {
    result?: string;
    is_error?: boolean;
    duration_ms?: number;
    usage?: { total_tokens?: number };
  },
  state: ExecutionState,
  subagentId: string,
  onProgress?: (update: SubagentProgressUpdate) => void,
): void {
  state.finalResult = event.result || "";
  state.resultStats = {
    durationMs: event.duration_ms || 0,
    totalTokens: event.usage?.total_tokens || 0,
  };

  if (event.is_error) {
    state.finalError = event.result || "Unknown error";
  } else {
    // Record any pending tool calls that weren't auto-approved
    for (const [id, { name, args }] of state.pendingToolCalls.entries()) {
      if (name && !state.displayedToolCalls.has(id)) {
        recordToolCall(
          subagentId,
          id,
          name,
          args || "{}",
          state.displayedToolCalls,
          onProgress,
        );
      }
    }
  }

  // Update state store with final stats
  updateSubagent(subagentId, {
    totalTokens: state.resultStats.totalTokens,
    durationMs: state.resultStats.durationMs,
  });
}

/**
 * Process a single JSON event from the subagent stream
 */
function processStreamEvent(
  line: string,
  state: ExecutionState,
  agentDisplayURL: string,
  subagentId: string,
  onProgress?: (update: SubagentProgressUpdate) => void,
): void {
  try {
    let event = JSON.parse(line);

    // stream-json can optionally emit wrappers: { type: "stream_event", event: {...} }
    if (event?.type === "stream_event" && event.event) {
      event = event.event;
    }

    switch (event.type) {
      case "init":
      case "system":
        // Handle both legacy "init" type and new "system" type with subtype "init"
        if (event.type === "init" || event.subtype === "init") {
          handleInitEvent(event, state, agentDisplayURL, subagentId, onProgress);
        }
        break;

      case "message":
        if (event.message_type === "approval_request_message") {
          handleApprovalRequestEvent(event, state);
        } else if (event.message_type === "tool_call_message") {
          handleToolCallMessageEvent(event, state, subagentId, onProgress);
        }
        break;

      case "auto_approval":
        handleAutoApprovalEvent(event, state, subagentId, onProgress);
        break;

      case "result":
        handleResultEvent(event, state, subagentId, onProgress);
        break;

      case "error":
        state.finalError = event.error || event.message || "Unknown error";
        break;
    }
  } catch {
    // Not valid JSON, ignore
  }
}

/**
 * Parse the final result from stdout if not captured during streaming
 */
function parseResultFromStdout(
  stdout: string,
  agentId: string | null,
): SubagentResult {
  const lines = stdout.trim().split("\n");
  const lastLine = lines[lines.length - 1] ?? "";

  try {
    const result = JSON.parse(lastLine);

    if (result.type === "result") {
      return {
        agentId: agentId || "",
        report: result.result || "",
        success: !result.is_error,
        error: result.is_error ? result.result || "Unknown error" : undefined,
      };
    }

    return {
      agentId: agentId || "",
      report: "",
      success: false,
      error: "Unexpected output format from subagent",
    };
  } catch (parseError) {
    return {
      agentId: agentId || "",
      report: "",
      success: false,
      error: `Failed to parse subagent output: ${getErrorMessage(parseError)}`,
    };
  }
}

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Build CLI arguments for spawning a subagent
 */
function buildSubagentArgs(
  type: string,
  config: SubagentConfig,
  model: string | null,
  userPrompt: string,
  existingAgentId?: string,
  existingConversationId?: string,
  maxTurns?: number,
): string[] {
  const args: string[] = [];
  const isDeployingExisting = Boolean(
    existingAgentId || existingConversationId,
  );

  if (isDeployingExisting) {
    // Deploy existing agent/conversation
    if (existingConversationId) {
      // conversation_id is sufficient (headless derives agent from it)
      args.push("--conv", existingConversationId);
    } else if (existingAgentId) {
      // agent_id only - use --new to create a new conversation for thread safety
      // (multiple parallel calls to the same agent need separate conversations)
      args.push("--agent", existingAgentId, "--new");
    }
    // Don't pass --system (existing agent keeps its prompt)
    // Don't pass --model (existing agent keeps its model)
  } else {
    // Create new agent (original behavior)
    args.push("--new-agent", "--system", type);
    if (model) {
      args.push("--model", model);
    }
  }

  args.push("-p", userPrompt);
  args.push("--output-format", "stream-json");

  // Use subagent's configured permission mode, or inherit from parent
  const subagentMode = config.permissionMode;
  const parentMode = permissionMode.getMode();
  const modeToUse = subagentMode || parentMode;
  if (modeToUse !== "default") {
    args.push("--permission-mode", modeToUse);
  }

  // Build list of auto-approved tools:
  // 1. Inherit from parent (CLI + session rules)
  // 2. Add subagent's allowed tools (so they don't hang on approvals)
  const parentAllowedTools = cliPermissions.getAllowedTools();
  const sessionAllowRules = sessionPermissions.getRules().allow || [];
  const subagentTools =
    config.allowedTools !== "all" && Array.isArray(config.allowedTools)
      ? config.allowedTools
      : [];
  const combinedAllowedTools = [
    ...new Set([...parentAllowedTools, ...sessionAllowRules, ...subagentTools]),
  ];
  if (combinedAllowedTools.length > 0) {
    args.push("--allowedTools", combinedAllowedTools.join(","));
  }

  const parentDisallowedTools = cliPermissions.getDisallowedTools();
  if (parentDisallowedTools.length > 0) {
    args.push("--disallowedTools", parentDisallowedTools.join(","));
  }

  // Add memory block filtering if specified (only for new agents)
  if (!isDeployingExisting) {
    if (config.memoryBlocks === "none") {
      args.push("--init-blocks", "none");
    } else if (
      Array.isArray(config.memoryBlocks) &&
      config.memoryBlocks.length > 0
    ) {
      args.push("--init-blocks", config.memoryBlocks.join(","));
    }
  }

  // Add tool filtering if specified (applies to both new and existing agents)
  if (
    config.allowedTools !== "all" &&
    Array.isArray(config.allowedTools) &&
    config.allowedTools.length > 0
  ) {
    args.push("--tools", config.allowedTools.join(","));
  }

  // Add max turns limit if specified
  if (maxTurns !== undefined && maxTurns > 0) {
    args.push("--max-turns", String(maxTurns));
  }

  // Pre-load skills specified in the subagent config
  if (config.skills.length > 0) {
    args.push("--pre-load-skills", config.skills.join(","));
  }

  return args;
}

/**
 * Execute a subagent and collect its final report by spawning letta in headless mode
 *
 * @param type - Subagent type
 * @param config - Subagent configuration
 * @param model - Model handle to use
 * @param userPrompt - The task prompt
 * @param agentDisplayURL - Display URL for constructing agent links (UI only)
 * @param subagentId - ID for tracking
 * @param expansionChain - Full list of fallback models for rate limit retry
 * @param chainIndex - Current position in the expansion chain (for retry tracking)
 * @param signal - Optional abort signal
 */
async function executeSubagent(
  type: string,
  config: SubagentConfig,
  model: string | null,
  userPrompt: string,
  agentDisplayURL: string,
  subagentId: string,
  expansionChain: string[] = [],
  chainIndex = 0,
  signal?: AbortSignal,
  existingAgentId?: string,
  existingConversationId?: string,
  maxTurns?: number,
  onProgress?: (update: SubagentProgressUpdate) => void,
): Promise<SubagentResult> {
  // Check if already aborted before starting
  if (signal?.aborted) {
    return {
      agentId: "",
      report: "",
      success: false,
      error: INTERRUPTED_BY_USER,
    };
  }

  // Update the state with the model being used (may differ on retry/fallback)
  if (model) {
    updateSubagent(subagentId, { model });
    onProgress?.({ message: `[model] ${model}` });
  }

  try {
    let cliArgs = buildSubagentArgs(
      type,
      config,
      model,
      userPrompt,
      existingAgentId,
      existingConversationId,
      maxTurns,
    );

    // Spawn Letta Code in headless mode.
    // Use the same binary as the current process, with fallbacks:
    // 1. LETTA_CODE_BIN env var (explicit override)
    // 2. Current process argv[1] if it's a .js file (built letta.js)
    // 3. Dev mode: use process.execPath (bun) with the .ts script as first arg
    // 4. "letta" (global install)
    const currentScript = process.argv[1] || "";
    let lettaCmd =
      process.env.LETTA_CODE_BIN ||
      (currentScript.endsWith(".js") ? currentScript : null) ||
      "letta";
    // In dev mode (running .ts file via bun), use the runtime binary directly
    // and prepend the script path to the CLI args
    if (currentScript.endsWith(".ts") && !process.env.LETTA_CODE_BIN) {
      lettaCmd = process.execPath; // e.g., /path/to/bun
      cliArgs = [currentScript, ...cliArgs];
    }
    // Pass parent agent ID so subagents can access parent's context (e.g., search history)
    let parentAgentId: string | undefined;
    try {
      parentAgentId = getCurrentAgentId();
    } catch {
      // Context not available
    }

    // Resolve auth once in parent and forward to child to avoid per-subagent
    // keychain lookups under high parallel fan-out.
    const settings = await settingsManager.getSettingsWithSecureTokens();
    const inheritedApiKey =
      process.env.LETTA_API_KEY || settings.env?.LETTA_API_KEY;
    const inheritedBaseUrl =
      process.env.LETTA_BASE_URL || settings.env?.LETTA_BASE_URL;

    const proc = spawn(lettaCmd, cliArgs, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...(inheritedApiKey && { LETTA_API_KEY: inheritedApiKey }),
        ...(inheritedBaseUrl && { LETTA_BASE_URL: inheritedBaseUrl }),
        // Tag Task-spawned agents for easy filtering.
        LETTA_CODE_AGENT_ROLE: "subagent",
        // Pass parent agent ID for subagents that need to access parent's context
        ...(parentAgentId && { LETTA_PARENT_AGENT_ID: parentAgentId }),
      },
    });

    // Set up abort handler to kill the child process
    let wasAborted = false;
    const abortHandler = () => {
      wasAborted = true;
      proc.kill("SIGTERM");
    };
    signal?.addEventListener("abort", abortHandler);

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    // Initialize execution state
    const state: ExecutionState = {
      agentId: existingAgentId || null,
      conversationId: existingConversationId || null,
      finalResult: null,
      finalError: null,
      resultStats: null,
      displayedToolCalls: new Set(),
      pendingToolCalls: new Map(),
    };

    // Create readline interface to parse JSON events line by line
    const rl = createInterface({
      input: proc.stdout,
      crlfDelay: Number.POSITIVE_INFINITY,
    });

    rl.on("line", (line: string) => {
      stdoutChunks.push(Buffer.from(`${line}\n`));
      processStreamEvent(line, state, agentDisplayURL, subagentId, onProgress);
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderrChunks.push(data);
    });

    // Wait for process to complete
    const exitCode = await new Promise<number | null>((resolve) => {
      proc.on("close", resolve);
      proc.on("error", () => resolve(null));
    });

    // Clean up abort listener
    signal?.removeEventListener("abort", abortHandler);

    // Check if process was aborted by user
    if (wasAborted) {
      return {
        agentId: state.agentId || "",
        conversationId: state.conversationId || undefined,
        report: "",
        success: false,
        error: INTERRUPTED_BY_USER,
      };
    }

    const stderr = Buffer.concat(stderrChunks).toString("utf-8").trim();

    // Handle non-zero exit code
    if (exitCode !== 0) {
      // Check if this is a recoverable model error
      const isRecoverableError =
        isProviderNotSupportedError(stderr) || isUnknownModelError(stderr);
      if (chainIndex === 0 && isRecoverableError) {
        // Try next model in chain first
        const nextModel = expansionChain[1];
        if (expansionChain.length > 1 && nextModel) {
          console.warn(
            `[subagent] Model error on ${model}, trying next model in chain: ${nextModel}`,
          );
          return executeSubagent(
            type,
            config,
            nextModel,
            userPrompt,
            agentDisplayURL,
            subagentId,
            expansionChain,
            1,
            signal,
            existingAgentId,
            existingConversationId,
            maxTurns,
            onProgress,
          );
        }

        // Fall back to primary agent's model as last resort
        const primaryModelHandle = await getPrimaryAgentModelHandle();
        if (primaryModelHandle && primaryModelHandle !== model) {
          console.warn(
            `[subagent] Model error detected, retrying with primary agent's model: ${primaryModelHandle}`,
          );
          return executeSubagent(
            type,
            config,
            primaryModelHandle,
            userPrompt,
            agentDisplayURL,
            subagentId,
            [], // No chain for fallback
            0,
            signal,
            undefined, // existingAgentId
            undefined, // existingConversationId
            maxTurns,
            onProgress,
          );
        }
      }

      const propagatedError = state.finalError?.trim();
      const fallbackError = stderr || `Subagent exited with code ${exitCode}`;

      return {
        agentId: state.agentId || "",
        conversationId: state.conversationId || undefined,
        report: "",
        success: false,
        error: propagatedError || fallbackError,
      };
    }

    // Return captured result if available
    if (state.finalResult !== null) {
      return {
        agentId: state.agentId || "",
        conversationId: state.conversationId || undefined,
        report: state.finalResult,
        success: !state.finalError,
        error: state.finalError || undefined,
        totalTokens: state.resultStats?.totalTokens,
      };
    }

    // Return error if captured
    if (state.finalError) {
      return {
        agentId: state.agentId || "",
        conversationId: state.conversationId || undefined,
        report: "",
        success: false,
        error: state.finalError,
        totalTokens: state.resultStats?.totalTokens,
      };
    }

    // Fallback: parse from stdout
    const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
    return parseResultFromStdout(stdout, state.agentId);
  } catch (error) {
    return {
      agentId: "",
      report: "",
      success: false,
      error: getErrorMessage(error),
    };
  }
}

/**
 * Get the display URL for constructing agent links shown in the UI.
 * This is for display purposes only - API calls use getClient() which has its own logic.
 */
function getAgentDisplayURL(): string {
  const settings = settingsManager.getSettings();

  const baseURL =
    process.env.LETTA_BASE_URL ||
    settings.env?.LETTA_BASE_URL ||
    "https://api.letta.com";

  // Convert API URL to web UI URL if using hosted service
  if (baseURL === "https://api.letta.com") {
    return "https://app.letta.com";
  }

  // If a custom server UUID is provided, use the Letta web app URL
  // This allows users with custom Letta servers to link to the web UI
  // e.g., https://app.letta.com/development-servers/[UUID]/agents/agent-...
  const customServerUUID =
    process.env.CUSTOM_LETTA_SERVER_UUID ||
    settings.env?.CUSTOM_LETTA_SERVER_UUID;
  if (customServerUUID) {
    return `https://app.letta.com/development-servers/${customServerUUID}`;
  }

  return baseURL;
}

/**
 * Check if a selector entry is a concrete model identifier.
 */
function isConcreteModelSelector(entry: string): boolean {
  return !entry.startsWith("group:") && entry !== "inherit" && entry !== "any";
}

/**
 * Pick a fallback model when server resolution fails.
 */
export async function getFallbackModelFromSelector(
  selector: string[],
  parentModelHandle: string | undefined,
): Promise<string> {
  if (parentModelHandle) {
    return parentModelHandle;
  }

  for (const entry of selector) {
    if (!isConcreteModelSelector(entry)) {
      continue;
    }

    // If it already looks like a handle, use it directly.
    if (entry.includes("/")) {
      return entry;
    }

    // Try resolving a static model ID first.
    const resolvedStatic = resolveModel(entry);
    if (resolvedStatic) {
      return resolvedStatic;
    }

    // Try resolving dynamically (best-effort; may fail offline).
    try {
      const resolvedDynamic = await resolveModelAsync(entry);
      if (resolvedDynamic) {
        return resolvedDynamic;
      }
    } catch {
      // Ignore and fall through to default.
    }
  }

  return getDefaultModel();
}

/**
 * Resolve a model selector using the server's resolver endpoint.
 * Returns both the resolved handle and the full expansion chain for fallback.
 *
 * @param selector - Ordered list of selector entries (group:X, inherit, any, or handles)
 * @param parentModelHandle - Parent agent's model handle for 'inherit' resolution
 * @returns Full ModelSelectorResponse with resolved_handle and expansion_chain
 */
async function resolveModelSelectorWithChain(
  selector: string[],
  parentModelHandle: string | undefined,
): Promise<ModelSelectorResponse> {
  try {
    const client = await getClient();

    // Call the server's resolve endpoint
    const response = await client.request<ModelSelectorResponse>({
      method: "post",
      path: "/v1/models/resolve",
      body: {
        selector,
        parent_model_handle: parentModelHandle,
      },
    });

    return response;
  } catch (error) {
    console.warn(
      `[subagent] Server model resolution failed: ${getErrorMessage(error)}. Using fallback.`,
    );

    const fallbackModel = await getFallbackModelFromSelector(
      selector,
      parentModelHandle,
    );
    return {
      resolved_handle: fallbackModel,
      expansion_chain: [fallbackModel],
    };
  }
}

/**
 * Resolve a model selector using the server's resolver endpoint.
 *
 * @param selector - Ordered list of selector entries (group:X, inherit, any, or handles)
 * @param parentModelHandle - Parent agent's model handle for 'inherit' resolution
 * @returns Resolved model handle
 */
async function resolveModelSelector(
  selector: string[],
  parentModelHandle: string | undefined,
): Promise<string> {
  const response = await resolveModelSelectorWithChain(
    selector,
    parentModelHandle,
  );
  return response.resolved_handle;
}

/**
 * Build a system reminder prefix for deployed agents
 */
function buildDeploySystemReminder(
  senderAgentName: string,
  senderAgentId: string,
  subagentType: string,
): string {
  const toolDescription =
    subagentType === "explore"
      ? "read-only tools (Read, Glob, Grep)"
      : "local tools (Bash, Read, Write, Edit, etc.)";

  return `${SYSTEM_REMINDER_OPEN}
This task is from "${senderAgentName}" (agent ID: ${senderAgentId}), which deployed you as a subagent inside the Letta Code CLI (docs.letta.com/letta-code).
You have access to ${toolDescription} in their codebase.
Your final message will be returned to the caller.
${SYSTEM_REMINDER_CLOSE}

`;
}

/**
 * Spawn a subagent and execute it autonomously
 *
 * @param type - Subagent type (e.g., "code-reviewer", "explore")
 * @param prompt - The task prompt for the subagent
 * @param userModel - Optional model override from the parent agent
 * @param subagentId - ID for tracking in the state store (registered by Task tool)
 * @param signal - Optional abort signal for interruption handling
 * @param existingAgentId - Optional ID of an existing agent to deploy
 * @param existingConversationId - Optional conversation ID to resume
 */
export async function spawnSubagent(
  type: string,
  prompt: string,
  userModel: string | undefined,
  subagentId: string,
  signal?: AbortSignal,
  existingAgentId?: string,
  existingConversationId?: string,
  maxTurns?: number,
  onProgress?: (update: SubagentProgressUpdate) => void,
): Promise<SubagentResult> {
  const allConfigs = await getAllSubagentConfigs();
  const config = allConfigs[type];

  if (!config) {
    return {
      agentId: "",
      report: "",
      success: false,
      error: `Unknown subagent type: ${type}`,
    };
  }

  const isDeployingExisting = Boolean(
    existingAgentId || existingConversationId,
  );

  const parentModelHandle = await getPrimaryAgentModelHandle();

  // For existing agents, don't override model; for new agents, resolve using our selector logic
  let model: string | null = null;
  let expansionChain: string[] = [];

  if (!isDeployingExisting) {
    // Resolve model using the server's selector resolver
    // We get both the resolved model AND the expansion chain for rate limit fallback
    if (userModel) {
      // Check if userModel is a selector (group:*, inherit, any) vs a concrete model
      const isSelector =
        userModel.startsWith("group:") ||
        userModel === "inherit" ||
        userModel === "any";

      if (isSelector) {
        // User specified a selector - resolve it through the selector resolver
        const resolution = await resolveModelSelectorWithChain(
          [userModel, "any"], // Add "any" as fallback
          parentModelHandle,
        );
        model = resolution.resolved_handle;
        expansionChain = resolution.expansion_chain;
      } else {
        // User specified a concrete model - try to resolve it
        const resolved = await resolveModelAsync(userModel);
        if (resolved) {
          model = resolved;
          expansionChain = [resolved];
        } else if (userModel.includes("/")) {
          // If it looks like a full handle but couldn't be resolved,
          // use it anyway (user might know something we don't)
          // but log a warning
          console.warn(
            `[subagent] Model "${userModel}" not found in available models, using as-is`,
          );
          model = userModel;
          expansionChain = [userModel];
        } else {
          // Not a full handle and couldn't be resolved - fall back to config's selector
          console.warn(
            `[subagent] Unknown model "${userModel}", falling back to config selector`,
          );
          const selector = config.modelSelector || [config.recommendedModel];
          const resolution = await resolveModelSelectorWithChain(
            selector,
            parentModelHandle || undefined,
          );
          model = resolution.resolved_handle;
          expansionChain = resolution.expansion_chain;
        }
      }
    } else {
      // Use the model selector chain from config
      const selector = config.modelSelector || [config.recommendedModel];

      // Resolve via server (with fallback) - get full chain for rate limit retry
      const resolution = await resolveModelSelectorWithChain(
        selector,
        parentModelHandle || undefined,
      );
      model = resolution.resolved_handle;
      expansionChain = resolution.expansion_chain;
    }
  } else if (existingAgentId) {
    // For deployed existing agents, surface the agent's configured model in the UI.
    try {
      const client = await getClient();
      const existingAgent = await client.agents.retrieve(existingAgentId);
      model = getModelHandleFromAgent(existingAgent);
    } catch {
      // Best effort only - subagent can still run without this metadata.
    }
  }

  const agentDisplayURL = getAgentDisplayURL();

  // Build the prompt with system reminder for deployed agents
  let finalPrompt = prompt;
  if (isDeployingExisting) {
    try {
      const parentAgentId = getCurrentAgentId();
      const client = await getClient();
      const parentAgent = await client.agents.retrieve(parentAgentId);
      const systemReminder = buildDeploySystemReminder(
        parentAgent.name,
        parentAgentId,
        type,
      );
      finalPrompt = systemReminder + prompt;
    } catch {
      // If we can't get parent agent info, proceed without the reminder
    }
  }

  // Execute subagent with retry policy for transient failures.
  let retryAgentId = existingAgentId;
  let retryConversationId = existingConversationId;
  let attempt = 0;
  let lastResult: SubagentResult | null = null;

  while (attempt <= MAX_TRANSIENT_RETRIES) {
    const result = await executeSubagent(
      type,
      config,
      model,
      finalPrompt,
      agentDisplayURL,
      subagentId,
      expansionChain,
      0,
      signal,
      retryAgentId,
      retryConversationId,
      maxTurns,
      onProgress,
    );

    lastResult = result;
    if (result.success) {
      return result;
    }

    if (result.error === INTERRUPTED_BY_USER || signal?.aborted) {
      return result;
    }

    const retryable = isRetryableSubagentError(result.error);
    if (!retryable || attempt >= MAX_TRANSIENT_RETRIES) {
      break;
    }

    // Reuse discovered IDs so retries can continue the same agent session.
    if (result.agentId) {
      retryAgentId = result.agentId;
    }
    if (result.conversationId) {
      retryConversationId = result.conversationId;
    }

    const delayMs = computeRetryDelayMs(attempt + 1);
    onProgress?.({
      message:
        `[retry] attempt ${attempt + 1}/${MAX_TRANSIENT_RETRIES + 1} failed with transient error; retrying in ${delayMs}ms`,
      agentId: retryAgentId,
      conversationId: retryConversationId,
    });

    const shouldContinue = await waitForRetryDelay(delayMs, signal);
    if (!shouldContinue) {
      return {
        agentId: retryAgentId || "",
        conversationId: retryConversationId || undefined,
        report: "",
        success: false,
        error: INTERRUPTED_BY_USER,
      };
    }

    attempt += 1;
  }

  if (lastResult && attempt > 0) {
    onProgress?.({
      message:
        `[retry-exhausted] subagent failed after ${attempt + 1} attempts`,
      agentId: lastResult.agentId || retryAgentId,
      conversationId: lastResult.conversationId || retryConversationId,
    });
  }

  return (
    lastResult || {
      agentId: retryAgentId || "",
      conversationId: retryConversationId || undefined,
      report: "",
      success: false,
      error: "Subagent execution failed",
    }
  );
}
