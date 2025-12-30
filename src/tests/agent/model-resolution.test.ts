/**
 * Tests for model resolution utilities including dynamic model support.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  resolveModel,
  resolveModelAsync,
  getModelInfo,
  getModelUpdateArgs,
  isDynamicModel,
  formatAvailableModels,
} from "../../agent/model";

// Mock the available-models module
vi.mock("../../agent/available-models", () => ({
  getAvailableModelHandles: vi.fn(),
  getModelContextWindow: vi.fn(),
}));

import { getAvailableModelHandles, getModelContextWindow } from "../../agent/available-models";

describe("resolveModel (synchronous)", () => {
  it("should resolve a static model by ID", () => {
    const result = resolveModel("sonnet-4.5");
    expect(result).toBe("anthropic/claude-sonnet-4-5-20250929");
  });

  it("should resolve a static model by handle", () => {
    const result = resolveModel("anthropic/claude-sonnet-4-5-20250929");
    expect(result).toBe("anthropic/claude-sonnet-4-5-20250929");
  });

  it("should return null for unknown model", () => {
    const result = resolveModel("unknown-model-xyz");
    expect(result).toBeNull();
  });

  it("should return null for dynamic model (not in static list)", () => {
    const result = resolveModel("zai-glm-4.7");
    expect(result).toBeNull();
  });
});

describe("resolveModelAsync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should resolve a static model by ID without server call", async () => {
    const result = await resolveModelAsync("sonnet-4.5");
    expect(result).toBe("anthropic/claude-sonnet-4-5-20250929");
    expect(getAvailableModelHandles).not.toHaveBeenCalled();
  });

  it("should resolve a static model by handle without server call", async () => {
    const result = await resolveModelAsync("anthropic/claude-sonnet-4-5-20250929");
    expect(result).toBe("anthropic/claude-sonnet-4-5-20250929");
    expect(getAvailableModelHandles).not.toHaveBeenCalled();
  });

  it("should resolve a dynamic model from server by exact handle", async () => {
    (getAvailableModelHandles as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      handles: new Set(["cliproxy/zai-glm-4.7", "cliproxy/other-model"]),
      source: "network",
      fetchedAt: Date.now(),
    });

    const result = await resolveModelAsync("cliproxy/zai-glm-4.7");
    expect(result).toBe("cliproxy/zai-glm-4.7");
    expect(getAvailableModelHandles).toHaveBeenCalled();
  });

  it("should resolve a dynamic model from server by short name", async () => {
    (getAvailableModelHandles as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      handles: new Set(["cliproxy/zai-glm-4.7"]),
      source: "network",
      fetchedAt: Date.now(),
    });

    const result = await resolveModelAsync("zai-glm-4.7");
    expect(result).toBe("cliproxy/zai-glm-4.7");
  });

  it("should return null if dynamic model not found on server", async () => {
    (getAvailableModelHandles as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      handles: new Set(["cliproxy/other-model"]),
      source: "network",
      fetchedAt: Date.now(),
    });

    const result = await resolveModelAsync("nonexistent-model");
    expect(result).toBeNull();
  });

  it("should return null if server call fails", async () => {
    (getAvailableModelHandles as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Network error"));

    const result = await resolveModelAsync("zai-glm-4.7");
    expect(result).toBeNull();
  });
});

describe("getModelInfo", () => {
  it("should return info for static model by ID", () => {
    const info = getModelInfo("sonnet-4.5");
    expect(info).not.toBeNull();
    expect(info?.id).toBe("sonnet-4.5");
    expect(info?.handle).toBe("anthropic/claude-sonnet-4-5-20250929");
  });

  it("should return info for static model by handle", () => {
    const info = getModelInfo("anthropic/claude-sonnet-4-5-20250929");
    expect(info).not.toBeNull();
    expect(info?.id).toBe("sonnet-4.5");
  });

  it("should return null for unknown model", () => {
    const info = getModelInfo("unknown-model");
    expect(info).toBeNull();
  });
});

describe("getModelUpdateArgs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return updateArgs for static model", () => {
    const args = getModelUpdateArgs("sonnet-4.5");
    expect(args).toBeDefined();
    expect(args?.context_window).toBe(180000);
  });

  it("should return defaults for dynamic model", () => {
    (getModelContextWindow as unknown as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    const args = getModelUpdateArgs("zai-glm-4.7");
    expect(args).toBeDefined();
    expect(args?.context_window).toBe(128000); // Default
    expect(args?.max_output_tokens).toBe(32000); // Default
  });

  it("should use cached context window for dynamic model", () => {
    (getModelContextWindow as unknown as ReturnType<typeof vi.fn>).mockReturnValue(256000);

    const args = getModelUpdateArgs("zai-glm-4.7");
    expect(args).toBeDefined();
    expect(args?.context_window).toBe(256000);
  });

  it("should return undefined for undefined input", () => {
    const args = getModelUpdateArgs(undefined);
    expect(args).toBeUndefined();
  });
});

describe("isDynamicModel", () => {
  it("should return false for static model", () => {
    expect(isDynamicModel("sonnet-4.5")).toBe(false);
    expect(isDynamicModel("anthropic/claude-sonnet-4-5-20250929")).toBe(false);
  });

  it("should return true for dynamic model", () => {
    expect(isDynamicModel("zai-glm-4.7")).toBe(true);
    expect(isDynamicModel("cliproxy/zai-glm-4.7")).toBe(true);
    expect(isDynamicModel("unknown-model")).toBe(true);
  });
});

describe("formatAvailableModels", () => {
  it("should format static models", () => {
    const formatted = formatAvailableModels();
    expect(formatted).toContain("sonnet-4.5");
    expect(formatted).toContain("anthropic/claude-sonnet-4-5-20250929");
  });
});
