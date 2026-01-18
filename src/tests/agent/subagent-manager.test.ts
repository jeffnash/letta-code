/**
 * Tests for subagent manager helpers.
 */
import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

import * as clientModule from "../../agent/client";
import * as contextModule from "../../agent/context";
import * as modelModule from "../../agent/model";
import { getPrimaryAgentModelHandle } from "../../agent/subagents/manager";

describe("getPrimaryAgentModelHandle", () => {
  let mockGetClient: ReturnType<typeof spyOn>;
  let mockGetCurrentAgentId: ReturnType<typeof spyOn>;
  let mockResolveModelAsync: ReturnType<typeof spyOn>;

  beforeEach(() => {
    mockGetClient?.mockRestore?.();
    mockGetCurrentAgentId?.mockRestore?.();
    mockResolveModelAsync?.mockRestore?.();

    // Set up default mock for getCurrentAgentId
    mockGetCurrentAgentId = spyOn(
      contextModule,
      "getCurrentAgentId",
    ).mockReturnValue("agent-1");
  });

  test("returns handle when present on llm_config", async () => {
    mockGetClient = spyOn(clientModule, "getClient").mockResolvedValue({
      agents: {
        retrieve: mock().mockResolvedValue({
          llm_config: { handle: "openai/gpt-5.2" },
        }),
      },
    } as unknown as Awaited<ReturnType<typeof clientModule.getClient>>);

    mockResolveModelAsync = spyOn(modelModule, "resolveModelAsync");

    const result = await getPrimaryAgentModelHandle();

    expect(result).toBe("openai/gpt-5.2");
    expect(mockResolveModelAsync).not.toHaveBeenCalled();
  });

  test("resolves handle from llm_config.model when handle missing", async () => {
    mockGetClient = spyOn(clientModule, "getClient").mockResolvedValue({
      agents: {
        retrieve: mock().mockResolvedValue({
          llm_config: { model: "gpt-5.2" },
        }),
      },
    } as unknown as Awaited<ReturnType<typeof clientModule.getClient>>);

    mockResolveModelAsync = spyOn(
      modelModule,
      "resolveModelAsync",
    ).mockResolvedValue("openai/gpt-5.2");

    const result = await getPrimaryAgentModelHandle();

    expect(result).toBe("openai/gpt-5.2");
    expect(mockResolveModelAsync).toHaveBeenCalledWith("gpt-5.2");
  });

  test("returns undefined when resolution fails", async () => {
    mockGetClient = spyOn(clientModule, "getClient").mockResolvedValue({
      agents: {
        retrieve: mock().mockResolvedValue({
          llm_config: { model: "unknown-model" },
        }),
      },
    } as unknown as Awaited<ReturnType<typeof clientModule.getClient>>);

    mockResolveModelAsync = spyOn(
      modelModule,
      "resolveModelAsync",
    ).mockResolvedValue(null);

    const result = await getPrimaryAgentModelHandle();

    expect(result).toBeUndefined();
  });

  test("returns undefined when llm_config missing", async () => {
    mockGetClient = spyOn(clientModule, "getClient").mockResolvedValue({
      agents: {
        retrieve: mock().mockResolvedValue({}),
      },
    } as unknown as Awaited<ReturnType<typeof clientModule.getClient>>);

    const result = await getPrimaryAgentModelHandle();

    expect(result).toBeUndefined();
  });
});
