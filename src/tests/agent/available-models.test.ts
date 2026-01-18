/**
 * Tests for available model cache and context window parsing.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
  clearAvailableModelsCache,
  getAvailableModelHandles,
} from "../../agent/available-models";
import { getClient } from "../../agent/client";

mock.module("../../agent/client", () => ({
  getClient: mock(),
}));

const mockGetClient = getClient as unknown as ReturnType<typeof mock>;

describe("getAvailableModelHandles", () => {
  beforeEach(() => {
    clearAvailableModelsCache();
    mockGetClient.mockReset?.();
  });

  test("prefers context_window over max_context_window", async () => {
    const modelsList = [
      {
        handle: "cliproxy/gpt-5-mini",
        context_window: 9000,
        max_context_window: 12000,
      },
      {
        handle: "cliproxy/gpt-5-strong",
        max_context_window: 16000,
      },
    ];

    mockGetClient.mockResolvedValue({
      models: {
        list: mock().mockResolvedValue(modelsList),
      },
    });

    const result = await getAvailableModelHandles({ forceRefresh: true });

    expect(result.contextWindows?.get("cliproxy/gpt-5-mini")).toBe(9000);
    expect(result.contextWindows?.get("cliproxy/gpt-5-strong")).toBe(16000);
  });

  test("uses context_window_limit alias when present", async () => {
    const modelsList = [
      {
        handle: "cliproxy/gpt-5-alias",
        context_window_limit: 18000,
      },
    ];

    mockGetClient.mockResolvedValue({
      models: {
        list: mock().mockResolvedValue(modelsList),
      },
    });

    const result = await getAvailableModelHandles({ forceRefresh: true });

    expect(result.contextWindows?.get("cliproxy/gpt-5-alias")).toBe(18000);
  });

  test("uses max_context_window_limit alias when present", async () => {
    const modelsList = [
      {
        handle: "cliproxy/gpt-5-max-alias",
        max_context_window_limit: 20000,
      },
    ];

    mockGetClient.mockResolvedValue({
      models: {
        list: mock().mockResolvedValue(modelsList),
      },
    });

    const result = await getAvailableModelHandles({ forceRefresh: true });

    expect(result.contextWindows?.get("cliproxy/gpt-5-max-alias")).toBe(20000);
  });
});
