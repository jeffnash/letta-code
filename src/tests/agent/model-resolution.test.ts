/**
 * Tests for model resolution utilities including dynamic model support.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatAvailableModels,
  getModelInfo,
  getModelUpdateArgs,
  isDynamicModel,
  resolveModel,
  resolveModelAsync,
} from "../../agent/model";

// Mock the available-models module
vi.mock("../../agent/available-models", () => ({
  getAvailableModelHandles: vi.fn(),
  getModelContextWindow: vi.fn(),
}));

import {
  getAvailableModelHandles,
  getModelContextWindow,
} from "../../agent/available-models";

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
    // Use a fictional model name that will never be in models.json
    const result = resolveModel("fictional-dynamic-model-xyz");
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
    const result = await resolveModelAsync(
      "anthropic/claude-sonnet-4-5-20250929",
    );
    expect(result).toBe("anthropic/claude-sonnet-4-5-20250929");
    expect(getAvailableModelHandles).not.toHaveBeenCalled();
  });

  it("should resolve a dynamic model from server by exact handle", async () => {
    (
      getAvailableModelHandles as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      handles: new Set(["cliproxy/fictional-dynamic-xyz", "cliproxy/other-model"]),
      source: "network",
      fetchedAt: Date.now(),
    });

    const result = await resolveModelAsync("cliproxy/fictional-dynamic-xyz");
    expect(result).toBe("cliproxy/fictional-dynamic-xyz");
    expect(getAvailableModelHandles).toHaveBeenCalled();
  });

  it("should resolve a dynamic model from server by short name", async () => {
    (
      getAvailableModelHandles as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      handles: new Set(["cliproxy/fictional-dynamic-xyz"]),
      source: "network",
      fetchedAt: Date.now(),
    });

    const result = await resolveModelAsync("fictional-dynamic-xyz");
    expect(result).toBe("cliproxy/fictional-dynamic-xyz");
  });

  it("should return null if dynamic model not found on server", async () => {
    (
      getAvailableModelHandles as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      handles: new Set(["cliproxy/other-model"]),
      source: "network",
      fetchedAt: Date.now(),
    });

    const result = await resolveModelAsync("nonexistent-model");
    expect(result).toBeNull();
  });

  it("should return null if server call fails", async () => {
    (
      getAvailableModelHandles as unknown as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error("Network error"));

    // Use a fictional model that's not in static list
    const result = await resolveModelAsync("fictional-dynamic-xyz");
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
    (
      getModelContextWindow as unknown as ReturnType<typeof vi.fn>
    ).mockReturnValue(undefined);

    // Use a fictional model that's not in static list
    const args = getModelUpdateArgs("fictional-dynamic-xyz");
    expect(args).toBeDefined();
    expect(args?.context_window).toBe(128000); // Default
    expect(args?.max_output_tokens).toBe(32000); // Default
  });

  it("should use cached context window for dynamic model", () => {
    (
      getModelContextWindow as unknown as ReturnType<typeof vi.fn>
    ).mockReturnValue(256000);

    // Use a fictional model that's not in static list
    const args = getModelUpdateArgs("fictional-dynamic-xyz");
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
    // zai-glm-4.7 is now in models.json, so it's static
    expect(isDynamicModel("zai-glm-4.7")).toBe(false);
    expect(isDynamicModel("cliproxy/zai-glm-4.7")).toBe(false);
  });

  it("should return true for dynamic model", () => {
    // Use fictional models that will never be in models.json
    expect(isDynamicModel("fictional-dynamic-xyz")).toBe(true);
    expect(isDynamicModel("cliproxy/fictional-dynamic-xyz")).toBe(true);
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
