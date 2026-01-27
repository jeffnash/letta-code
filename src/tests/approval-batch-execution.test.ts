import { describe, expect, test, mock, beforeEach } from "bun:test";
import type { ToolReturnMessage } from "@letta-ai/letta-client/resources/tools";

/**
 * Tests for approval batch execution, specifically the fix for tool_call_id mismatch errors.
 *
 * The fix ensures that when parallel tool execution is interrupted or fails,
 * ALL tool_call_ids get a result (even if it's an error/interrupted status),
 * preventing the server from rejecting partial responses.
 *
 * Related issue: Race condition during parallel tool execution with human-in-the-loop approval.
 * When users interrupt mid-execution or errors occur, some tools complete normally while
 * others get interrupted/fail before completion.
 */

// We need to test the executeApprovalBatch function behavior, but since it has complex
// dependencies (executeTool, tool imports), we'll test the key logic paths via mocking.

// Import the actual module to test
import {
  executeApprovalBatch,
  type ApprovalDecision,
} from "../agent/approval-execution";

// Mock the executeTool function
const mockExecuteTool = mock(() =>
  Promise.resolve({
    resultStr: "mocked result",
    status: "success" as const,
    durationMs: 100,
  }),
);

// We'll mock the module
mock.module("../tools/manager", () => ({
  executeTool: mockExecuteTool,
}));

describe("executeApprovalBatch", () => {
  beforeEach(() => {
    mockExecuteTool.mockClear();
  });

  /**
   * Helper to create an ApprovalDecision for testing
   */
  function createApprovalDecision(
    toolCallId: string,
    toolName: string,
    type: "approve" | "deny" = "approve",
  ): ApprovalDecision {
    if (type === "deny") {
      return {
        type: "deny",
        approval: {
          toolCallId,
          toolName,
          toolArgs: "{}",
        },
        reason: "Test denial reason",
      };
    }
    return {
      type: "approve",
      approval: {
        toolCallId,
        toolName,
        toolArgs: "{}",
      },
    };
  }

  test("returns results for all decisions when execution succeeds", async () => {
    // Mock successful execution
    mockExecuteTool.mockResolvedValue({
      resultStr: "success",
      status: "success",
      durationMs: 100,
    });

    const decisions: ApprovalDecision[] = [
      createApprovalDecision("call-1", "Read"),
      createApprovalDecision("call-2", "Grep"),
    ];

    const chunks: ToolReturnMessage[] = [];
    const onChunk = (chunk: ToolReturnMessage) => chunks.push(chunk);

    const results = await executeApprovalBatch(decisions, onChunk);

    // Should have results for all decisions
    expect(results).toHaveLength(2);
    expect(results[0]?.tool_call_id).toBe("call-1");
    expect(results[1]?.tool_call_id).toBe("call-2");
  });

  test("fills in missing results when execution is interrupted", async () => {
    // Create an AbortController to simulate user interruption
    const abortController = new AbortController();

    // Mock first tool to succeed, then abort before second can complete
    let callCount = 0;
    mockExecuteTool.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // First call succeeds, then abort
        setTimeout(() => abortController.abort(), 10);
        return { resultStr: "first success", status: "success", durationMs: 50 };
      }
      // Second call: wait a bit then check abort
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (abortController.signal.aborted) {
        throw new Error("Aborted");
      }
      return { resultStr: "second success", status: "success", durationMs: 50 };
    });

    const decisions: ApprovalDecision[] = [
      createApprovalDecision("call-1", "Read"),
      createApprovalDecision("call-2", "Grep"),
    ];

    const chunks: ToolReturnMessage[] = [];
    const onChunk = (chunk: ToolReturnMessage) => chunks.push(chunk);

    const results = await executeApprovalBatch(decisions, onChunk, {
      abortSignal: abortController.signal,
    });

    // KEY ASSERTION: Should still have results for ALL decisions, even if some failed/aborted
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.tool_call_id).sort()).toEqual([
      "call-1",
      "call-2",
    ]);
  });

  test("handles denied decisions correctly", async () => {
    const decisions: ApprovalDecision[] = [
      createApprovalDecision("call-1", "Bash", "deny"),
      createApprovalDecision("call-2", "Write", "deny"),
    ];

    const chunks: ToolReturnMessage[] = [];
    const onChunk = (chunk: ToolReturnMessage) => chunks.push(chunk);

    const results = await executeApprovalBatch(decisions, onChunk);

    // Should have results for all denials
    expect(results).toHaveLength(2);
    expect(results[0]?.tool_call_id).toBe("call-1");
    // Denials return ApprovalReturn with approve: false
    expect((results[0] as { approve?: boolean })?.approve).toBe(false);
    expect(results[1]?.tool_call_id).toBe("call-2");
    expect((results[1] as { approve?: boolean })?.approve).toBe(false);
  });

  test("handles mixed approved and denied decisions", async () => {
    mockExecuteTool.mockResolvedValue({
      resultStr: "success",
      status: "success",
      durationMs: 100,
    });

    const decisions: ApprovalDecision[] = [
      createApprovalDecision("call-1", "Read", "approve"),
      createApprovalDecision("call-2", "Bash", "deny"),
      createApprovalDecision("call-3", "Grep", "approve"),
    ];

    const chunks: ToolReturnMessage[] = [];
    const onChunk = (chunk: ToolReturnMessage) => chunks.push(chunk);

    const results = await executeApprovalBatch(decisions, onChunk);

    // Should have results for ALL decisions
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.tool_call_id).sort()).toEqual([
      "call-1",
      "call-2",
      "call-3",
    ]);
  });

  test("catches unhandled Promise.all errors and fills missing results", async () => {
    // Simulate an unexpected error that causes Promise.all to fail
    let callCount = 0;
    mockExecuteTool.mockImplementation(async () => {
      callCount++;
      if (callCount === 2) {
        throw new Error("Unexpected catastrophic error");
      }
      return { resultStr: "success", status: "success", durationMs: 100 };
    });

    const decisions: ApprovalDecision[] = [
      createApprovalDecision("call-1", "Read"),
      createApprovalDecision("call-2", "Glob"), // This will throw
      createApprovalDecision("call-3", "Grep"),
    ];

    const chunks: ToolReturnMessage[] = [];
    const onChunk = (chunk: ToolReturnMessage) => chunks.push(chunk);

    const results = await executeApprovalBatch(decisions, onChunk);

    // KEY ASSERTION: Even if errors occur, all tool_call_ids should have results
    // The fix ensures we loop through and fill in any null results after Promise.all
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.tool_call_id).sort()).toEqual([
      "call-1",
      "call-2",
      "call-3",
    ]);
  });

  test("returns empty array for empty decisions", async () => {
    const results = await executeApprovalBatch([], () => {});
    expect(results).toHaveLength(0);
  });
});

describe("executeApprovalBatch result completeness", () => {
  /**
   * This test specifically verifies the fix for the tool_call_id mismatch bug.
   *
   * Before the fix:
   * - If Promise.all had unhandled rejections, some results could be null
   * - The server would get fewer tool_call_ids than expected and reject with:
   *   "Expected N ID(s): [...], but received M ID(s): [...]"
   *
   * After the fix:
   * - A try/catch around Promise.all catches any unhandled errors
   * - A post-execution loop fills in ANY null results with interrupted/error status
   * - The server always gets responses for ALL tool_call_ids
   */
  test("always returns exactly one result per decision regardless of execution outcome", async () => {
    // Test with various scenarios that could cause partial results
    const scenarios = [
      { numDecisions: 1, name: "single decision" },
      { numDecisions: 3, name: "multiple decisions" },
      { numDecisions: 5, name: "many decisions" },
    ];

    for (const scenario of scenarios) {
      const decisions: ApprovalDecision[] = [];
      for (let i = 0; i < scenario.numDecisions; i++) {
        const isApprove = i % 2 === 0;
        if (isApprove) {
          decisions.push({
            type: "approve",
            approval: {
              toolCallId: `call-${i}`,
              toolName: "Read",
              toolArgs: "{}",
            },
          });
        } else {
          decisions.push({
            type: "deny",
            approval: {
              toolCallId: `call-${i}`,
              toolName: "Bash",
              toolArgs: "{}",
            },
            reason: "Test denial",
          });
        }
      }

      const results = await executeApprovalBatch(decisions, () => {});

      // This is the critical assertion: result count must match decision count
      expect(results.length).toBe(scenario.numDecisions);

      // All results should have valid tool_call_ids
      for (let i = 0; i < scenario.numDecisions; i++) {
        expect(results[i]?.tool_call_id).toBe(`call-${i}`);
      }
    }
  });
});
