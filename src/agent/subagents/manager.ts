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
  updateSubagent,
} from "../../cli/helpers/subagentState.js";
import { INTERRUPTED_BY_USER } from "../../constants";
import { cliPermissions } from "../../permissions/cli";
import { permissionMode } from "../../permissions/mode";
import { sessionPermissions } from "../../permissions/session";
import { settingsManager } from "../../settings-manager";
import { getErrorMessage } from "../../utils/error";
import { getClient } from "../client";
import { getCurrentAgentId } from "../context";
import { getDefaultModel, resolveModel, resolveModelAsync } from "../model";
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
  report: string;
  success: boolean;
  error?: string;
  totalTokens?: number;
}

/**
 * State tracked during subagent execution
 */
interface ExecutionState {
  agentId: string | null;
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
export async function getPrimaryAgentModelHandle(): Promise<
  string | undefined
> {
  try {
    const agentId = getCurrentAgentId();
    const client = await getClient();
    const agent = await client.agents.retrieve(agentId);
    const llmConfig = agent.llm_config as
      | { model?: string; handle?: string }
      | undefined;
    if (llmConfig?.handle) {
      return llmConfig.handle;
    }

    const model = llmConfig?.model;
    if (!model) {
      return undefined;
    }

    const resolved = await resolveModelAsync(model);
    return resolved ?? undefined;
  } catch {
    return undefined;
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
): void {
  if (!toolCallId || !toolName || displayedToolCalls.has(toolCallId)) return;
  displayedToolCalls.add(toolCallId);
  addToolCall(subagentId, toolCallId, toolName, toolArgs);
}

/**
 * Handle an init event from the subagent stream
 */
function handleInitEvent(
  event: { agent_id?: string },
  state: ExecutionState,
  baseURL: string,
  subagentId: string,
): void {
  if (event.agent_id) {
    state.agentId = event.agent_id;
    const agentURL = `${baseURL}/agents/${event.agent_id}`;
    updateSubagent(subagentId, { agentURL });
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
  event: { tool_call_id?: string; tool_name?: string; tool_args?: string },
  state: ExecutionState,
  subagentId: string,
): void {
  const { tool_call_id, tool_name, tool_args = "{}" } = event;
  if (tool_call_id && tool_name) {
    recordToolCall(
      subagentId,
      tool_call_id,
      tool_name,
      tool_args,
      state.displayedToolCalls,
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
  baseURL: string,
  subagentId: string,
): void {
  try {
    const event = JSON.parse(line);

    switch (event.type) {
      case "init":
        handleInitEvent(event, state, baseURL, subagentId);
        break;

      case "message":
        if (event.message_type === "approval_request_message") {
          handleApprovalRequestEvent(event, state);
        }
        break;

      case "auto_approval":
        handleAutoApprovalEvent(event, state, subagentId);
        break;

      case "result":
        handleResultEvent(event, state, subagentId);
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
  model: string,
  userPrompt: string,
): string[] {
  const args: string[] = [
    "--new",
    "--system",
    type,
    "--model",
    model,
    "-p",
    userPrompt,
    "--output-format",
    "stream-json",
  ];

  // Inherit permission mode from parent
  const currentMode = permissionMode.getMode();
  if (currentMode !== "default") {
    args.push("--permission-mode", currentMode);
  }

  // Inherit permission rules from parent (CLI + session rules)
  const parentAllowedTools = cliPermissions.getAllowedTools();
  const sessionAllowRules = sessionPermissions.getRules().allow || [];
  const combinedAllowedTools = [
    ...new Set([...parentAllowedTools, ...sessionAllowRules]),
  ];
  if (combinedAllowedTools.length > 0) {
    args.push("--allowedTools", combinedAllowedTools.join(","));
  }
  const parentDisallowedTools = cliPermissions.getDisallowedTools();
  if (parentDisallowedTools.length > 0) {
    args.push("--disallowedTools", parentDisallowedTools.join(","));
  }

  // Add memory block filtering if specified
  if (config.memoryBlocks === "none") {
    args.push("--init-blocks", "none");
  } else if (
    Array.isArray(config.memoryBlocks) &&
    config.memoryBlocks.length > 0
  ) {
    args.push("--init-blocks", config.memoryBlocks.join(","));
  }

  // Add tool filtering if specified
  if (
    config.allowedTools !== "all" &&
    Array.isArray(config.allowedTools) &&
    config.allowedTools.length > 0
  ) {
    args.push("--tools", config.allowedTools.join(","));
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
 * @param baseURL - Base URL for agent links
 * @param subagentId - ID for tracking
 * @param expansionChain - Full list of fallback models for rate limit retry
 * @param chainIndex - Current position in the expansion chain (for retry tracking)
 * @param signal - Optional abort signal
 */
async function executeSubagent(
  type: string,
  config: SubagentConfig,
  model: string,
  userPrompt: string,
  baseURL: string,
  subagentId: string,
  expansionChain: string[] = [],
  chainIndex = 0,
  signal?: AbortSignal,
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
  updateSubagent(subagentId, { model });

  try {
    const cliArgs = buildSubagentArgs(type, config, model, userPrompt);

    // Spawn Letta Code in headless mode.
    // Some environments may have a different `letta` binary earlier in PATH.
    const lettaCmd = process.env.LETTA_CODE_BIN || "letta";
    const proc = spawn(lettaCmd, cliArgs, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        // Tag Task-spawned agents for easy filtering.
        LETTA_CODE_AGENT_ROLE: "subagent",
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
      agentId: null,
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
      processStreamEvent(line, state, baseURL, subagentId);
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
        report: "",
        success: false,
        error: INTERRUPTED_BY_USER,
      };
    }

    const stderr = Buffer.concat(stderrChunks).toString("utf-8").trim();

    // Handle non-zero exit code
    if (exitCode !== 0) {
      // Check for rate limit errors - try next model in expansion chain
      if (isRateLimitError(stderr) && expansionChain.length > 0) {
        // Find next available model in the chain after current one
        const nextIndex = chainIndex + 1;
        const nextModel = expansionChain[nextIndex];
        if (nextIndex < expansionChain.length && nextModel) {
          console.warn(
            `[subagent] Rate limit error on ${model}, trying next model in chain: ${nextModel}`,
          );
          return executeSubagent(
            type,
            config,
            nextModel,
            userPrompt,
            baseURL,
            subagentId,
            expansionChain,
            nextIndex,
            signal,
          );
        }
      }

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
            baseURL,
            subagentId,
            expansionChain,
            1,
            signal,
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
            baseURL,
            subagentId,
            [], // No chain for fallback
            0,
            signal,
          );
        }
      }

      return {
        agentId: state.agentId || "",
        report: "",
        success: false,
        error: stderr || `Subagent exited with code ${exitCode}`,
      };
    }

    // Return captured result if available
    if (state.finalResult !== null) {
      return {
        agentId: state.agentId || "",
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
 * Get the base URL for constructing agent links
 */
function getBaseURL(): string {
  const settings = settingsManager.getSettings();

  const baseURL =
    process.env.LETTA_BASE_URL ||
    settings.env?.LETTA_BASE_URL ||
    "https://api.letta.com";

  // Convert API URL to web UI URL if using hosted service
  if (baseURL === "https://api.letta.com") {
    return "https://app.letta.com";
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
 * Spawn a subagent and execute it autonomously
 *
 * @param type - Subagent type (e.g., "code-reviewer", "explore")
 * @param prompt - The task prompt for the subagent
 * @param userModel - Optional model override from the parent agent
 * @param subagentId - ID for tracking in the state store (registered by Task tool)
 * @param signal - Optional abort signal for interruption handling
 */
export async function spawnSubagent(
  type: string,
  prompt: string,
  userModel: string | undefined,
  subagentId: string,
  signal?: AbortSignal,
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

  // Get parent agent's model for 'inherit' resolution
  const parentModelHandle = await getPrimaryAgentModelHandle();

  // Resolve model using the server's selector resolver
  // We get both the resolved model AND the expansion chain for rate limit fallback
  let model: string;
  let expansionChain: string[] = [];

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

  const baseURL = getBaseURL();

  // Execute subagent - state updates are handled via the state store
  // Pass expansion chain for rate limit fallback
  const result = await executeSubagent(
    type,
    config,
    model,
    prompt,
    baseURL,
    subagentId,
    expansionChain,
    0, // Start at beginning of chain
    signal,
  );

  return result;
}
