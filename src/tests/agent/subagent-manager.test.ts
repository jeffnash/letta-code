/**
 * Tests for subagent manager helpers.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../agent/client", () => ({
  getClient: vi.fn(),
}));

vi.mock("../../agent/context", () => ({
  getCurrentAgentId: vi.fn(() => "agent-1"),
}));

vi.mock("../../agent/model", () => ({
  getDefaultModel: vi.fn(),
  resolveModel: vi.fn(),
  resolveModelAsync: vi.fn(),
}));

import { getClient } from "../../agent/client";
import { resolveModelAsync } from "../../agent/model";
import { getPrimaryAgentModelHandle } from "../../agent/subagents/manager";

const mockGetClient = getClient as unknown as ReturnType<typeof vi.fn>;
const mockResolveModelAsync = resolveModelAsync as unknown as ReturnType<
  typeof vi.fn
>;

describe("getPrimaryAgentModelHandle", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns handle when present on llm_config", async () => {
    mockGetClient.mockResolvedValue({
      agents: {
        retrieve: vi.fn().mockResolvedValue({
          llm_config: { handle: "openai/gpt-5.2" },
        }),
      },
    });

    const result = await getPrimaryAgentModelHandle();

    expect(result).toBe("openai/gpt-5.2");
    expect(mockResolveModelAsync).not.toHaveBeenCalled();
  });

  it("resolves handle from llm_config.model when handle missing", async () => {
    mockGetClient.mockResolvedValue({
      agents: {
        retrieve: vi.fn().mockResolvedValue({
          llm_config: { model: "gpt-5.2" },
        }),
      },
    });
    mockResolveModelAsync.mockResolvedValue("openai/gpt-5.2");

    const result = await getPrimaryAgentModelHandle();

    expect(result).toBe("openai/gpt-5.2");
    expect(mockResolveModelAsync).toHaveBeenCalledWith("gpt-5.2");
  });

  it("returns undefined when resolution fails", async () => {
    mockGetClient.mockResolvedValue({
      agents: {
        retrieve: vi.fn().mockResolvedValue({
          llm_config: { model: "unknown-model" },
        }),
      },
    });
    mockResolveModelAsync.mockResolvedValue(null);

    const result = await getPrimaryAgentModelHandle();

    expect(result).toBeUndefined();
  });

  it("returns undefined when llm_config missing", async () => {
    mockGetClient.mockResolvedValue({
      agents: {
        retrieve: vi.fn().mockResolvedValue({}),
      },
    });

    const result = await getPrimaryAgentModelHandle();

    expect(result).toBeUndefined();
  });
});
