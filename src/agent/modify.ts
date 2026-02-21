// src/agent/modify.ts
// Utilities for modifying agent configuration

import type {
  AgentState,
  AnthropicModelSettings,
  GoogleAIModelSettings,
  OpenAIModelSettings,
} from "@letta-ai/letta-client/resources/agents/agents";
import type { LlmConfig } from "@letta-ai/letta-client/resources/models/models";
import { OPENAI_CODEX_PROVIDER_NAME } from "../providers/openai-codex-provider";
import { getModelContextWindow } from "./available-models";
import { getClient } from "./client";

type ModelSettings =
  | OpenAIModelSettings
  | AnthropicModelSettings
  | GoogleAIModelSettings
  | Record<string, unknown>;

/**
 * Builds model_settings from updateArgs based on provider type.
 * Always ensures parallel_tool_calls is enabled.
 */
function buildModelSettings(
  modelHandle: string,
  updateArgs?: Record<string, unknown>,
): ModelSettings {
  // Include our custom ChatGPT OAuth provider (chatgpt-plus-pro)
  const isOpenAI =
    modelHandle.startsWith("openai/") ||
    modelHandle.startsWith(`${OPENAI_CODEX_PROVIDER_NAME}/`);
  // Include legacy custom Anthropic OAuth provider (claude-pro-max)
  const isAnthropic =
    modelHandle.startsWith("anthropic/") ||
    modelHandle.startsWith("claude-pro-max/");
  const isZai = modelHandle.startsWith("zai/");
  const isGoogleAI = modelHandle.startsWith("google_ai/");
  const isGoogleVertex = modelHandle.startsWith("google_vertex/");
  const isOpenRouter = modelHandle.startsWith("openrouter/");
  const isBedrock = modelHandle.startsWith("bedrock/");
  // CLIProxy is a passthrough service - use OpenAI-compatible settings
  const isCLIProxy = modelHandle.startsWith("cliproxy/");

  let settings: ModelSettings;

  if (isOpenAI || isOpenRouter || isCLIProxy) {
    const openaiSettings: OpenAIModelSettings = {
      provider_type: "openai",
      parallel_tool_calls: true,
    };
    if (updateArgs?.reasoning_effort) {
      openaiSettings.reasoning = {
        reasoning_effort: updateArgs.reasoning_effort as
          | "none"
          | "minimal"
          | "low"
          | "medium"
          | "high",
      };
    }
    settings = openaiSettings;
  } else if (isAnthropic) {
    const anthropicSettings: AnthropicModelSettings = {
      provider_type: "anthropic",
      parallel_tool_calls: true,
    };
    // Build thinking config if either enable_reasoner or max_reasoning_tokens is specified
    if (
      updateArgs?.enable_reasoner !== undefined ||
      typeof updateArgs?.max_reasoning_tokens === "number"
    ) {
      anthropicSettings.thinking = {
        type: updateArgs?.enable_reasoner === false ? "disabled" : "enabled",
        ...(typeof updateArgs?.max_reasoning_tokens === "number" && {
          budget_tokens: updateArgs.max_reasoning_tokens,
        }),
      };
    }
    settings = anthropicSettings;
  } else if (isZai) {
    // Zai uses the same model_settings structure as other providers.
    // Ensure parallel_tool_calls is enabled.
    settings = {
      provider_type: "zai",
      parallel_tool_calls: true,
    };
  } else if (isGoogleAI) {
    const googleSettings: GoogleAIModelSettings & { temperature?: number } = {
      provider_type: "google_ai",
      parallel_tool_calls: true,
    };
    if (updateArgs?.thinking_budget !== undefined) {
      googleSettings.thinking_config = {
        thinking_budget: updateArgs.thinking_budget as number,
      };
    }
    if (typeof updateArgs?.temperature === "number") {
      googleSettings.temperature = updateArgs.temperature as number;
    }
    settings = googleSettings;
  } else if (isGoogleVertex) {
    // Vertex AI uses the same Google provider on the backend; only the handle differs.
    const googleVertexSettings: Record<string, unknown> = {
      provider_type: "google_vertex",
      parallel_tool_calls: true,
    };
    if (updateArgs?.thinking_budget !== undefined) {
      (googleVertexSettings as Record<string, unknown>).thinking_config = {
        thinking_budget: updateArgs.thinking_budget as number,
      };
    }
    if (typeof updateArgs?.temperature === "number") {
      (googleVertexSettings as Record<string, unknown>).temperature =
        updateArgs.temperature as number;
    }
    settings = googleVertexSettings;
  } else if (isBedrock) {
    // AWS Bedrock - supports Anthropic Claude models with thinking config
    const bedrockSettings: Record<string, unknown> = {
      provider_type: "bedrock",
      parallel_tool_calls: true,
    };
    // Build thinking config if either enable_reasoner or max_reasoning_tokens is specified
    if (
      updateArgs?.enable_reasoner !== undefined ||
      typeof updateArgs?.max_reasoning_tokens === "number"
    ) {
      bedrockSettings.thinking = {
        type: updateArgs?.enable_reasoner === false ? "disabled" : "enabled",
        ...(typeof updateArgs?.max_reasoning_tokens === "number" && {
          budget_tokens: updateArgs.max_reasoning_tokens,
        }),
      };
    }
    settings = bedrockSettings;
  } else {
    // For BYOK/unknown providers, return generic settings with parallel_tool_calls
    settings = {};
  }

  // Apply max_output_tokens only when provider_type is present.
  // Without provider_type the discriminated union rejects the payload (e.g. MiniMax).
  if (
    typeof updateArgs?.max_output_tokens === "number" &&
    "provider_type" in settings
  ) {
    (settings as Record<string, unknown>).max_output_tokens =
      updateArgs.max_output_tokens;
  }

  return settings;
}

/**
 * Updates an agent's model and model settings.
 *
 * Uses the new model_settings field instead of deprecated llm_config.
 *
 * @param agentId - The agent ID
 * @param modelHandle - The model handle (e.g., "anthropic/claude-sonnet-4-5-20250929")
 * @param updateArgs - Additional config args (context_window, reasoning_effort, enable_reasoner, etc.)
 * @param preserveParallelToolCalls - If true, preserves the parallel_tool_calls setting when updating the model
 * @returns The updated LLM configuration from the server
 */
export async function updateAgentLLMConfig(
  agentId: string,
  modelHandle: string,
  updateArgs?: Record<string, unknown>,
): Promise<LlmConfig> {
  const client = await getClient();

  const modelSettings = buildModelSettings(modelHandle, updateArgs);
  // First try updateArgs, then fall back to API-cached context window for BYOK models
  const contextWindow =
    (updateArgs?.context_window as number | undefined) ??
    (await getModelContextWindow(modelHandle));
  const hasModelSettings = Object.keys(modelSettings).length > 0;

  await client.agents.update(agentId, {
    model: modelHandle,
    ...(hasModelSettings && { model_settings: modelSettings }),
    ...(contextWindow && { context_window_limit: contextWindow }),
    ...(typeof updateArgs?.max_output_tokens === "number" && {
      max_tokens: updateArgs.max_output_tokens,
    }),
  });

  const finalAgent = await client.agents.retrieve(agentId);
  return finalAgent.llm_config;
}

export interface SystemPromptUpdateResult {
  success: boolean;
  message: string;
}

/**
 * Updates an agent's system prompt with raw content.
 *
 * @param agentId - The agent ID
 * @param systemPromptContent - The raw system prompt content to update
 * @returns Result with success status and message
 */
export async function updateAgentSystemPromptRaw(
  agentId: string,
  systemPromptContent: string,
): Promise<SystemPromptUpdateResult> {
  try {
    const client = await getClient();

    await client.agents.update(agentId, {
      system: systemPromptContent,
    });

    return {
      success: true,
      message: "System prompt updated successfully",
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to update system prompt: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Result from updating a system prompt on an agent
 */
export interface UpdateSystemPromptResult {
  success: boolean;
  message: string;
  agent: AgentState | null;
}

/**
 * Updates an agent's system prompt by ID or subagent name.
 * Resolves the ID to content, updates the agent, and returns the refreshed agent state.
 *
 * @param agentId - The agent ID to update
 * @param systemPromptId - System prompt ID (e.g., "codex") or subagent name (e.g., "explore")
 * @returns Result with success status, message, and updated agent state
 */
export async function updateAgentSystemPrompt(
  agentId: string,
  systemPromptId: string,
): Promise<UpdateSystemPromptResult> {
  try {
    const { resolveSystemPrompt, SYSTEM_PROMPT_MEMORY_ADDON } = await import(
      "./promptAssets"
    );
    const baseContent = await resolveSystemPrompt(systemPromptId);
    // Append the non-memfs memory section by default.
    // If memfs is enabled, the caller should follow up with updateAgentSystemPromptMemfs().
    const systemPromptContent = `${baseContent}\n${SYSTEM_PROMPT_MEMORY_ADDON}`;

    const updateResult = await updateAgentSystemPromptRaw(
      agentId,
      systemPromptContent,
    );
    if (!updateResult.success) {
      return {
        success: false,
        message: updateResult.message,
        agent: null,
      };
    }

    // Re-fetch agent to get updated state
    const client = await getClient();
    const agent = await client.agents.retrieve(agentId);

    return {
      success: true,
      message: "System prompt applied successfully",
      agent,
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to apply system prompt: ${error instanceof Error ? error.message : String(error)}`,
      agent: null,
    };
  }
}

export interface LinkResult {
  success: boolean;
  message: string;
  addedCount?: number;
}

/**
 * Attach all Letta Code tools to an agent.
 * This looks up tool IDs on the server and attaches them to the agent,
 * also adding requires_approval rules for client-side execution.
 */
export async function linkToolsToAgent(agentId: string): Promise<LinkResult> {
  try {
    const client = await getClient();

    const agent = await client.agents.retrieve(agentId, {
      include: ["agent.tools"],
    });
    const currentTools = agent.tools || [];
    const currentToolIds = currentTools
      .map((t) => t.id)
      .filter((id): id is string => typeof id === "string");
    const currentToolNames = new Set(
      currentTools
        .map((t) => t.name)
        .filter((name): name is string => typeof name === "string"),
    );

    const { getServerToolName, getToolNames } = await import(
      "../tools/manager"
    );
    const lettaCodeToolNames = getToolNames();

    const toolsToAdd = lettaCodeToolNames.filter((internalName) => {
      const serverName = getServerToolName(internalName);
      return !currentToolNames.has(serverName);
    });

    if (toolsToAdd.length === 0) {
      return {
        success: true,
        message: "All Letta Code tools already attached",
        addedCount: 0,
      };
    }

    const toolsToAddIds = (
      await Promise.all(
        toolsToAdd.map(async (toolName) => {
          const serverName = getServerToolName(toolName);
          const toolsResponse = await client.tools.list({ name: serverName });
          return toolsResponse.items[0]?.id;
        }),
      )
    ).filter((id): id is string => !!id);

    const newToolIds = [...currentToolIds, ...toolsToAddIds];

    const currentToolRules = agent.tool_rules || [];
    const newToolRules = [
      ...currentToolRules,
      ...toolsToAdd.map((toolName) => ({
        tool_name: getServerToolName(toolName),
        type: "requires_approval" as const,
        prompt_template: null,
      })),
    ];

    await client.agents.update(agentId, {
      tool_ids: newToolIds,
      tool_rules: newToolRules,
    });

    return {
      success: true,
      message: `Attached ${toolsToAddIds.length} Letta Code tool(s) to agent`,
      addedCount: toolsToAddIds.length,
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export interface UnlinkResult {
  success: boolean;
  message: string;
  removedCount?: number;
}

/**
 * Remove all Letta Code tools from an agent.
 * This detaches client-side tools from the agent, typically before switching toolsets.
 */
export async function unlinkToolsFromAgent(
  agentId: string,
): Promise<UnlinkResult> {
  try {
    const client = await getClient();

    const agent = await client.agents.retrieve(agentId, {
      include: ["agent.tools"],
    });
    const currentTools = agent.tools || [];
    const currentToolIds = currentTools
      .map((t) => t.id)
      .filter((id): id is string => typeof id === "string");
    const currentToolNames = new Map(
      currentTools
        .filter((t) => typeof t.name === "string" && typeof t.id === "string")
        .map((t) => [t.name as string, t.id as string]),
    );

    const { getAllLettaToolNames, getServerToolName } = await import(
      "../tools/manager"
    );
    const allLettaToolNames = getAllLettaToolNames();

    // Find tools to remove (any Letta Code tool currently attached)
    const toolIdsToRemove = new Set<string>();
    for (const internalName of allLettaToolNames) {
      const serverName = getServerToolName(internalName);
      const toolId = currentToolNames.get(serverName);
      if (toolId) {
        toolIdsToRemove.add(toolId);
      }
    }

    if (toolIdsToRemove.size === 0) {
      return {
        success: true,
        message: "No Letta Code tools to remove",
        removedCount: 0,
      };
    }

    // Filter out the tools to remove
    const newToolIds = currentToolIds.filter((id) => !toolIdsToRemove.has(id));

    // Also remove tool rules for the removed tools
    const removedServerNames = new Set(
      allLettaToolNames.map((n) => getServerToolName(n)),
    );
    const newToolRules = (agent.tool_rules || []).filter(
      (r) => !removedServerNames.has(r.tool_name),
    );

    await client.agents.update(agentId, {
      tool_ids: newToolIds,
      tool_rules: newToolRules,
    });

    return {
      success: true,
      message: `Removed ${toolIdsToRemove.size} Letta Code tool(s) from agent`,
      removedCount: toolIdsToRemove.size,
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Updates an agent's system prompt to swap between the memfs and non-memfs memory sections.
 *
 * When enabling memfs: strips any existing # Memory section, appends the memfs memory addon.
 * When disabling memfs: strips any existing # Memory section, appends the non-memfs memory addon.
 *
 * @param agentId - The agent ID to update
 * @param enableMemfs - Whether to enable (add) or disable (remove) the memfs addon
 * @returns Result with success status and message
 */
export async function updateAgentSystemPromptMemfs(
  agentId: string,
  enableMemfs: boolean,
): Promise<SystemPromptUpdateResult> {
  try {
    const client = await getClient();
    const agent = await client.agents.retrieve(agentId);
    let currentSystemPrompt = agent.system || "";

    const { SYSTEM_PROMPT_MEMFS_ADDON, SYSTEM_PROMPT_MEMORY_ADDON } =
      await import("./promptAssets");

    // Strip any existing memory section (covers both old inline "# Memory" / "## Memory"
    // sections and the new addon format including "## Memory Filesystem" subsections).
    // Matches from "# Memory" or "## Memory" to the next top-level heading or end of string.
    const memoryHeaderRegex =
      /\n#{1,2} Memory\b[\s\S]*?(?=\n#{1,2} (?!Memory|Filesystem|Structure|How It Works|Syncing|History)[^\n]|$)/;
    currentSystemPrompt = currentSystemPrompt.replace(memoryHeaderRegex, "");

    // Append the appropriate memory section
    const addon = enableMemfs
      ? SYSTEM_PROMPT_MEMFS_ADDON
      : SYSTEM_PROMPT_MEMORY_ADDON;
    currentSystemPrompt = `${currentSystemPrompt}\n${addon}`;

    await client.agents.update(agentId, {
      system: currentSystemPrompt,
    });

    return {
      success: true,
      message: enableMemfs
        ? "System prompt updated to include Memory Filesystem section"
        : "System prompt updated to include standard Memory section",
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to update system prompt memfs: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
