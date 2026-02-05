/**
 * Model resolution and handling utilities
 */
import modelsData from "../models.json";
import {
  getAvailableModelHandles,
  getModelContextWindowSync,
} from "./available-models";

export const models = modelsData;

// Default values for dynamic models that don't have static config
const DEFAULT_DYNAMIC_MODEL_CONFIG = {
  context_window: 128000,
  max_output_tokens: 32000,
};

// Apply a safety buffer to avoid hitting provider hard limits exactly.
// This is especially important because we may add system prompt/tool schema overhead.
// NOTE: Default is 1.0 (no buffer) because the server already applies a safety factor.
// Set LETTA_CONTEXT_WINDOW_SAFETY_FACTOR=0.95 to apply additional client-side buffering.
const CONTEXT_WINDOW_SAFETY_FACTOR = Number.parseFloat(
  process.env.LETTA_CONTEXT_WINDOW_SAFETY_FACTOR ?? "1.0",
);
const MAX_OUTPUT_TOKENS_SAFETY_FACTOR = Number.parseFloat(
  process.env.LETTA_MAX_OUTPUT_TOKENS_SAFETY_FACTOR ?? "1.0",
);

function applySafetyLimit(
  value: unknown,
  safetyFactor: number,
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return undefined;
  if (!Number.isFinite(safetyFactor) || safetyFactor <= 0 || safetyFactor > 1)
    return Math.max(1, Math.floor(value));
  return Math.max(1, Math.floor(value * safetyFactor));
}

function applySafetyToUpdateArgs(
  updateArgs: Record<string, unknown>,
): Record<string, unknown> {
  const safe = { ...updateArgs };

  const safeContextWindow = applySafetyLimit(
    updateArgs.context_window,
    CONTEXT_WINDOW_SAFETY_FACTOR,
  );
  if (safeContextWindow) safe.context_window = safeContextWindow;

  const safeMaxOutputTokens = applySafetyLimit(
    updateArgs.max_output_tokens,
    MAX_OUTPUT_TOKENS_SAFETY_FACTOR,
  );
  if (safeMaxOutputTokens) safe.max_output_tokens = safeMaxOutputTokens;

  return safe;
}

/**
 * Resolve a model by ID or handle (synchronous - static list only)
 * @param modelIdentifier - Can be either a model ID (e.g., "opus-4.5") or a full handle (e.g., "anthropic/claude-opus-4-5")
 * @returns The model handle if found, null otherwise
 */
export function resolveModel(modelIdentifier: string): string | null {
  const byId = models.find((m) => m.id === modelIdentifier);
  if (byId) return byId.handle;

  const byHandle = models.find((m) => m.handle === modelIdentifier);
  if (byHandle) return byHandle.handle;

  // For self-hosted servers: if it looks like a handle (contains /), pass it through
  // This allows using models not in models.json (e.g., from server's /v1/models)
  if (modelIdentifier.includes("/")) {
    return modelIdentifier;
  }

  return null;
}

/**
 * Resolve a model by ID or handle with dynamic fallback to server
 * @param modelIdentifier - Can be either a model ID (e.g., "opus-4.5") or a full handle (e.g., "cliproxy/zai-glm-4.7")
 * @returns The model handle if found, null otherwise
 */
export async function resolveModelAsync(
  modelIdentifier: string,
): Promise<string | null> {
  // First, try static models.json lookup (fast path)
  const byId = models.find((m) => m.id === modelIdentifier);
  if (byId) return byId.handle;

  const byHandle = models.find((m) => m.handle === modelIdentifier);
  if (byHandle) return byHandle.handle;

  // If not in static list, check if server knows this model
  try {
    const available = await getAvailableModelHandles();

    // Check exact match on handle
    if (available.handles.has(modelIdentifier)) {
      return modelIdentifier;
    }

    // Check if any handle ends with the identifier (e.g., "zai-glm-4.7" -> "cliproxy/zai-glm-4.7")
    for (const handle of available.handles) {
      if (handle.endsWith(`/${modelIdentifier}`)) {
        return handle;
      }
    }

    // Check if identifier matches the model part of a handle
    for (const handle of available.handles) {
      const modelPart = handle.split("/").pop();
      if (modelPart === modelIdentifier) {
        return handle;
      }
    }
  } catch (_error) {
    // If server check fails, fall through to passthrough check below
  }

  // For self-hosted servers: if it looks like a handle (contains /), pass it through
  // This allows using models not in models.json (e.g., from server's /v1/models)
  if (modelIdentifier.includes("/")) {
    return modelIdentifier;
  }

  return null;
}

/**
 * Get the default model handle
 */
export function getDefaultModel(): string {
  const defaultModel = models.find((m) => m.isDefault);
  if (defaultModel) return defaultModel.handle;

  const firstModel = models[0];
  if (!firstModel) {
    throw new Error("No models available in models.json");
  }
  return firstModel.handle;
}

/**
 * Get the default model handle based on billing tier.
 * Free tier users get glm-4.7, everyone else gets the standard default.
 * @param billingTier - The user's billing tier (e.g., "free", "pro", "enterprise")
 * @returns The model handle to use as default
 */
export function getDefaultModelForTier(billingTier?: string | null): string {
  // Free tier gets glm-4.7 (a free model)
  if (billingTier?.toLowerCase() === "free") {
    const freeDefault = models.find((m) => m.id === "glm-4.7");
    if (freeDefault) return freeDefault.handle;
  }
  // Everyone else (pro, enterprise, unknown) gets the standard default
  return getDefaultModel();
}

/**
 * Format available models for error messages
 */
export function formatAvailableModels(): string {
  return models.map((m) => `  ${m.id.padEnd(24)} ${m.handle}`).join("\n");
}

/**
 * Format available models for error messages including dynamic models from server
 */
export async function formatAvailableModelsAsync(): Promise<string> {
  const staticModels = models
    .map((m) => `  ${m.id.padEnd(24)} ${m.handle}`)
    .join("\n");

  try {
    const available = await getAvailableModelHandles();
    const staticHandles = new Set(models.map((m) => m.handle));
    const dynamicHandles = [...available.handles]
      .filter((h) => !staticHandles.has(h))
      .sort();

    if (dynamicHandles.length > 0) {
      const dynamicSection = dynamicHandles
        .map((h) => {
          const shortName = h.split("/").pop() || h;
          return `  ${shortName.padEnd(24)} ${h} (dynamic)`;
        })
        .join("\n");
      return `Static models:\n${staticModels}\n\nDynamic models from server:\n${dynamicSection}`;
    }
  } catch {
    // Ignore errors, just show static models
  }

  return staticModels;
}

/**
 * Get model info by ID or handle
 * @param modelIdentifier - Can be either a model ID (e.g., "opus-4.5") or a full handle (e.g., "anthropic/claude-opus-4-5")
 * @returns The model info if found, null otherwise
 */
export function getModelInfo(modelIdentifier: string) {
  const byId = models.find((m) => m.id === modelIdentifier);
  if (byId) return byId;

  const byHandle = models.find((m) => m.handle === modelIdentifier);
  if (byHandle) return byHandle;

  return null;
}

/**
 * Get updateArgs for a model by ID or handle
 * For dynamic models not in the static list, returns sensible defaults.
 * @param modelIdentifier - Can be either a model ID (e.g., "opus-4.5") or a full handle (e.g., "anthropic/claude-opus-4-5")
 * @returns The updateArgs if found, or defaults for dynamic models
 */
export function getModelUpdateArgs(
  modelIdentifier?: string,
): Record<string, unknown> | undefined {
  if (!modelIdentifier) return undefined;

  // Try static model first
  const modelInfo = getModelInfo(modelIdentifier);
  if (modelInfo?.updateArgs) {
    return applySafetyToUpdateArgs(modelInfo.updateArgs);
  }

  // For dynamic models (not in static list), return sensible defaults
  // Try to get context window from cached server response (synchronous cache read)
  const contextWindow = getModelContextWindowSync(modelIdentifier);

  return applySafetyToUpdateArgs({
    context_window:
      contextWindow || DEFAULT_DYNAMIC_MODEL_CONFIG.context_window,
    max_output_tokens: DEFAULT_DYNAMIC_MODEL_CONFIG.max_output_tokens,
  });
}

/**
 * Get updateArgs for a model with async lookup for dynamic models
 * @param modelIdentifier - Model ID or handle
 * @returns The updateArgs with accurate context window from server if available
 */
export async function getModelUpdateArgsAsync(
  modelIdentifier?: string,
): Promise<Record<string, unknown> | undefined> {
  if (!modelIdentifier) return undefined;

  // Try static model first
  const modelInfo = getModelInfo(modelIdentifier);
  if (modelInfo?.updateArgs) {
    return applySafetyToUpdateArgs(modelInfo.updateArgs);
  }

  // For dynamic models, try to get context window from server
  try {
    const available = await getAvailableModelHandles();
    const contextWindow = available.contextWindows?.get(modelIdentifier);

    if (contextWindow) {
      return applySafetyToUpdateArgs({
        context_window: contextWindow,
        max_output_tokens: DEFAULT_DYNAMIC_MODEL_CONFIG.max_output_tokens,
      });
    }
  } catch {
    // Fall through to defaults
  }

  return applySafetyToUpdateArgs({
    context_window: DEFAULT_DYNAMIC_MODEL_CONFIG.context_window,
    max_output_tokens: DEFAULT_DYNAMIC_MODEL_CONFIG.max_output_tokens,
  });
}

/**
 * Find a model entry by handle with fuzzy matching support
 * @param handle - The full model handle
 * @returns The model entry if found, null otherwise
 */
function findModelByHandle(handle: string): (typeof models)[number] | null {
  // Try exact match first
  const exactMatch = models.find((m) => m.handle === handle);
  if (exactMatch) return exactMatch;

  // For handles like "bedrock/claude-opus-4-5-20251101" where the API returns without
  // vendor prefix or version suffix, but models.json has
  // "bedrock/us.anthropic.claude-opus-4-5-20251101-v1:0", try fuzzy matching
  const [provider, ...rest] = handle.split("/");
  if (provider && rest.length > 0) {
    const modelPortion = rest.join("/");
    // Find models with the same provider where the model portion is contained
    // in the models.json handle (handles vendor prefixes and version suffixes)
    const partialMatch = models.find((m) => {
      if (!m.handle.startsWith(`${provider}/`)) return false;
      const mModelPortion = m.handle.slice(provider.length + 1);
      // Check if either contains the other (handles both directions)
      return (
        mModelPortion.includes(modelPortion) ||
        modelPortion.includes(mModelPortion)
      );
    });
    if (partialMatch) return partialMatch;
  }

  return null;
}

/**
 * Get a display-friendly name for a model by its handle
 * @param handle - The full model handle (e.g., "anthropic/claude-sonnet-4-5-20250929")
 * @returns The display name (e.g., "Sonnet 4.5") if found, null otherwise
 */
export function getModelDisplayName(handle: string): string | null {
  const model = findModelByHandle(handle);
  return model?.label ?? null;
}

/**
 * Get a short display name for a model (for status bar)
 * Falls back to full label if no shortLabel is defined
 * @param handle - The full model handle
 * @returns The short name (e.g., "Opus 4.5 BR") if found, null otherwise
 */
export function getModelShortName(handle: string): string | null {
  const model = findModelByHandle(handle);
  if (!model) return null;
  // Use shortLabel if available, otherwise fall back to label
  return (model as { shortLabel?: string }).shortLabel ?? model.label;
}

/**
 * Resolve a model ID from the llm_config.model value
 * The llm_config.model is the model portion without the provider prefix
 * (e.g., "z-ai/glm-4.6:exacto" for handle "openrouter/z-ai/glm-4.6:exacto")
 *
 * Note: This may not distinguish between variants like gpt-5.2-medium vs gpt-5.2-high
 * since they share the same handle. For provider fallback, this is acceptable.
 *
 * @param llmConfigModel - The model value from agent.llm_config.model
 * @returns The model ID if found, null otherwise
 */
export function resolveModelByLlmConfig(llmConfigModel: string): string | null {
  // Try to find a model whose handle ends with the llm_config model value
  const match = models.find((m) => m.handle.endsWith(`/${llmConfigModel}`));
  if (match) return match.id;

  // Also try exact match on the model portion (for simple cases like "gpt-5.2")
  const exactMatch = models.find((m) => {
    const parts = m.handle.split("/");
    return parts.slice(1).join("/") === llmConfigModel;
  });
  if (exactMatch) return exactMatch.id;

  return null;
}

/**
 * Check if a model identifier is a dynamic model (not in static list)
 * @param modelIdentifier - Model ID or handle
 * @returns true if the model is dynamic (from server, not in models.json)
 */
export function isDynamicModel(modelIdentifier: string): boolean {
  return getModelInfo(modelIdentifier) === null;
}
