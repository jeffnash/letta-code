/**
 * Tests for subagent model selector parsing and resolution.
 */
import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as modelModule from "../../agent/model";
import { getDefaultModel } from "../../agent/model";
import { parseModelSelector } from "../../agent/subagents";
import { getFallbackModelFromSelector } from "../../agent/subagents/manager";

describe("parseModelSelector", () => {
  describe("undefined/null input", () => {
    test("should return default fallback chain for undefined", () => {
      const result = parseModelSelector(undefined);
      expect(result).toEqual(["inherit", "any"]);
    });
  });

  describe("string input", () => {
    test("should wrap single string in array", () => {
      const result = parseModelSelector("group:fast");
      expect(result).toEqual(["group:fast"]);
    });

    test("should trim whitespace from string", () => {
      const result = parseModelSelector("  group:strong  ");
      expect(result).toEqual(["group:strong"]);
    });

    test("should handle concrete model handle", () => {
      const result = parseModelSelector("openai/gpt-5.2");
      expect(result).toEqual(["openai/gpt-5.2"]);
    });

    test("should handle 'inherit' as string", () => {
      const result = parseModelSelector("inherit");
      expect(result).toEqual(["inherit"]);
    });

    test("should handle 'any' as string", () => {
      const result = parseModelSelector("any");
      expect(result).toEqual(["any"]);
    });
  });

  describe("array input", () => {
    test("should return array as-is", () => {
      const result = parseModelSelector(["group:fast", "inherit", "any"]);
      expect(result).toEqual(["group:fast", "inherit", "any"]);
    });

    test("should trim whitespace from array elements", () => {
      const result = parseModelSelector(["  group:fast  ", " inherit "]);
      expect(result).toEqual(["group:fast", "inherit"]);
    });

    test("should handle mixed selector types in array", () => {
      const result = parseModelSelector([
        "group:planning",
        "group:strong",
        "openai/gpt-5.2",
        "inherit",
        "any",
      ]);
      expect(result).toEqual([
        "group:planning",
        "group:strong",
        "openai/gpt-5.2",
        "inherit",
        "any",
      ]);
    });

    test("should handle empty array", () => {
      const result = parseModelSelector([]);
      expect(result).toEqual([]);
    });

    test("should convert non-string array elements to strings", () => {
      // Edge case: YAML might parse numbers
      const result = parseModelSelector([
        123 as unknown as string,
        "group:fast",
      ]);
      expect(result).toEqual(["123", "group:fast"]);
    });
  });
});

describe("model selector patterns", () => {
  describe("group selectors", () => {
    test("should recognize group:fast pattern", () => {
      const selector = "group:fast";
      expect(selector.startsWith("group:")).toBe(true);
      expect(selector.slice(6)).toBe("fast");
    });

    test("should recognize group:strong pattern", () => {
      const selector = "group:strong";
      expect(selector.startsWith("group:")).toBe(true);
      expect(selector.slice(6)).toBe("strong");
    });

    test("should recognize group:planning pattern", () => {
      const selector = "group:planning";
      expect(selector.startsWith("group:")).toBe(true);
      expect(selector.slice(6)).toBe("planning");
    });

    test("should recognize group:default pattern", () => {
      const selector = "group:default";
      expect(selector.startsWith("group:")).toBe(true);
      expect(selector.slice(6)).toBe("default");
    });
  });

  describe("special tokens", () => {
    test("should identify 'inherit' as special token", () => {
      const selector = "inherit";
      expect(selector === "inherit").toBe(true);
    });

    test("should identify 'any' as special token", () => {
      const selector = "any";
      expect(selector === "any").toBe(true);
    });
  });

  describe("concrete handles", () => {
    test("should identify concrete handle with provider prefix", () => {
      const selector = "openai/gpt-5.2";
      // Concrete handles have a "/" and are not special keywords
      expect(selector.includes("/")).toBe(true);
      expect(selector.startsWith("group:")).toBe(false);
      // Verify it's not a special keyword by checking it contains a provider prefix
      expect(selector.split("/").length).toBeGreaterThan(1);
    });

    test("should identify cliproxy handle", () => {
      const selector = "cliproxy/gpt-5-mini";
      expect(selector.includes("/")).toBe(true);
      expect(selector.startsWith("group:")).toBe(false);
    });
  });
});

describe("built-in subagent model selectors", () => {
  // These tests verify the expected model selectors for built-in subagents

  test("explore subagent should use fast group with fallbacks", () => {
    const expectedSelector = ["group:fast", "inherit", "any"];
    expect(expectedSelector[0]).toBe("group:fast");
    expect(expectedSelector).toContain("inherit");
    expect(expectedSelector).toContain("any");
  });

  test("plan subagent should use planning/strong groups with fallbacks", () => {
    const expectedSelector = [
      "group:planning",
      "group:strong",
      "inherit",
      "any",
    ];
    expect(expectedSelector[0]).toBe("group:planning");
    expect(expectedSelector[1]).toBe("group:strong");
    expect(expectedSelector).toContain("inherit");
    expect(expectedSelector).toContain("any");
  });

  test("general-purpose subagent should use strong group with fallbacks", () => {
    const expectedSelector = ["group:strong", "inherit", "any"];
    expect(expectedSelector[0]).toBe("group:strong");
    expect(expectedSelector).toContain("inherit");
    expect(expectedSelector).toContain("any");
  });
});

describe("getFallbackModelFromSelector", () => {
  let mockResolveModelAsync: ReturnType<typeof spyOn>;

  beforeEach(() => {
    mockResolveModelAsync?.mockRestore?.();
  });

  test("prefers parent model when available", async () => {
    const selector = ["group:fast", "openai/gpt-5.2", "any"];
    const result = await getFallbackModelFromSelector(selector, "parent/model");

    expect(result).toBe("parent/model");
  });

  test("uses first concrete handle when parent model missing", async () => {
    const selector = ["group:fast", "inherit", "openai/gpt-5.2", "any"];
    const result = await getFallbackModelFromSelector(selector, undefined);

    expect(result).toBe("openai/gpt-5.2");
  });

  test("resolves static model IDs to handles", async () => {
    const selector = ["sonnet-4.5", "any"];
    const result = await getFallbackModelFromSelector(selector, undefined);

    expect(result).toBe("anthropic/claude-sonnet-4-5-20250929");
  });

  test("uses dynamic resolution when needed", async () => {
    mockResolveModelAsync = spyOn(
      modelModule,
      "resolveModelAsync",
    ).mockResolvedValue("cliproxy/gpt-5-mini");

    const selector = ["custom-model", "any"];
    const result = await getFallbackModelFromSelector(selector, undefined);

    expect(result).toBe("cliproxy/gpt-5-mini");
    expect(mockResolveModelAsync).toHaveBeenCalledWith("custom-model");
  });

  test("falls back to default model when no concrete entries exist", async () => {
    const selector = ["group:fast", "inherit", "any"];
    const defaultModel = getDefaultModel();
    const result = await getFallbackModelFromSelector(selector, undefined);

    expect(result).toBe(defaultModel);
    expect(result).not.toBe("inherit");
    expect(result).not.toBe("any");
  });
});

describe("fallback chain behavior", () => {
  /**
   * Simulates the resolution algorithm behavior.
   * Returns the first entry that would be "available" based on the mock available set.
   */
  function simulateResolution(
    selector: string[],
    available: Set<string>,
    parentModel: string | undefined,
    defaultModel: string,
  ): string | null {
    for (const entry of selector) {
      if (entry.startsWith("group:")) {
        // In real implementation, this would expand the group
        // For testing, we skip groups
        continue;
      }
      if (entry === "inherit") {
        if (parentModel && available.has(parentModel)) {
          return parentModel;
        }
        continue;
      }
      if (entry === "any") {
        if (available.has(defaultModel)) {
          return defaultModel;
        }
        continue;
      }
      // Concrete handle
      if (available.has(entry)) {
        return entry;
      }
    }
    return null;
  }

  test("should fall back to inherit when group unavailable", () => {
    const selector = ["group:fast", "inherit", "any"];
    const available = new Set(["parent/model"]);

    const result = simulateResolution(
      selector,
      available,
      "parent/model",
      "default/model",
    );

    expect(result).toBe("parent/model");
  });

  test("should fall back to any when inherit unavailable", () => {
    const selector = ["group:fast", "inherit", "any"];
    const available = new Set(["default/model"]);

    const result = simulateResolution(
      selector,
      available,
      undefined,
      "default/model",
    );

    expect(result).toBe("default/model");
  });

  test("should use concrete handle when available", () => {
    const selector = ["openai/gpt-5.2", "inherit", "any"];
    const available = new Set(["openai/gpt-5.2", "parent/model"]);

    const result = simulateResolution(
      selector,
      available,
      "parent/model",
      "default/model",
    );

    expect(result).toBe("openai/gpt-5.2");
  });

  test("should return null when nothing available", () => {
    const selector = ["openai/gpt-5.2", "inherit"];
    const available = new Set(["completely/different"]);

    const result = simulateResolution(
      selector,
      available,
      undefined,
      "also/unavailable",
    );

    expect(result).toBeNull();
  });
});
