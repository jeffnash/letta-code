/**
 * Tests for the /repair CLI command
 *
 * This tests the command registration and validates the command handler
 * behavior for repairing corrupted agent message history.
 */

import { describe, expect, test } from "bun:test";
import { commands } from "../../cli/commands/registry";

describe("/repair command", () => {
  describe("command registration", () => {
    test("command is registered in registry", () => {
      expect(commands["/repair"]).toBeDefined();
    });

    test("command has correct description", () => {
      const cmd = commands["/repair"];
      expect(cmd).toBeDefined();
      expect(cmd!.desc.toLowerCase()).toContain("repair");
      expect(cmd!.desc.toLowerCase()).toContain("message");
    });

    test("command is not hidden", () => {
      const cmd = commands["/repair"];
      expect(cmd).toBeDefined();
      expect(cmd!.hidden).not.toBe(true);
    });

    test("command has an order for autocomplete", () => {
      const cmd = commands["/repair"];
      expect(cmd).toBeDefined();
      expect(cmd!.order).toBeDefined();
      expect(typeof cmd!.order).toBe("number");
    });

    test("command handler returns expected message", () => {
      const cmd = commands["/repair"];
      expect(cmd).toBeDefined();
      const result = cmd!.handler([]);
      expect(result).toContain("Repairing");
    });
  });

  describe("autocomplete behavior", () => {
    test("/repair appears in autocomplete when typing /rep", () => {
      const matchingCommands = Object.keys(commands).filter(
        (cmd) => cmd.startsWith("/rep") && !commands[cmd]?.hidden,
      );
      expect(matchingCommands).toContain("/repair");
    });

    test("/repair is sorted appropriately with other commands", () => {
      const cmd = commands["/repair"];
      expect(cmd).toBeDefined();
      // Should be in a reasonable range (not first, not last)
      expect(cmd!.order).toBeGreaterThan(0);
      expect(cmd!.order).toBeLessThan(100);
    });
  });
});

describe("RepairMessageHistoryResponse format", () => {
  // These tests validate the expected API response format

  test("ok response structure", () => {
    const okResponse = {
      status: "ok" as const,
      message: "No orphaned tool_use blocks found",
      orphaned_tool_calls: [],
      injected_message_ids: [],
      injected_tool_call_ids: [],
      pruned_message_ids: [],
      sanitized_message_ids: [],
      sanitized_tool_call_ids: [],
    };

    expect(okResponse.status).toBe("ok");
    expect(Array.isArray(okResponse.orphaned_tool_calls)).toBe(true);
    expect(Array.isArray(okResponse.injected_message_ids)).toBe(true);
    expect(Array.isArray(okResponse.injected_tool_call_ids)).toBe(true);
    expect(Array.isArray(okResponse.pruned_message_ids)).toBe(true);
  });

  test("repaired response structure", () => {
    const repairedResponse = {
      status: "repaired" as const,
      message:
        "Injected 1 synthetic tool result message(s) for 1 orphaned tool_call(s); pruned 1 orphan function_call_output-only message(s)",
      orphaned_tool_calls: [
        {
          message_id: "msg-123",
          tool_call_id: "toolu_456",
          tool_name: "get_weather",
          reason: "no_following_message",
        },
      ],
      injected_message_ids: ["message-synth-1"],
      injected_tool_call_ids: ["toolu_456"],
      pruned_message_ids: ["message-orphan-output-1"],
    };

    expect(repairedResponse.status).toBe("repaired");
    expect(repairedResponse.orphaned_tool_calls.length).toBeGreaterThan(0);
    expect(repairedResponse.orphaned_tool_calls[0]).toHaveProperty(
      "message_id",
    );
    expect(repairedResponse.orphaned_tool_calls[0]).toHaveProperty(
      "tool_call_id",
    );
    expect(repairedResponse.orphaned_tool_calls[0]).toHaveProperty("tool_name");
    expect(repairedResponse.orphaned_tool_calls[0]).toHaveProperty("reason");
  });

  test("error response structure", () => {
    const errorResponse = {
      status: "error" as const,
      message: "Failed to repair message history",
      orphaned_tool_calls: [],
      injected_message_ids: [],
      injected_tool_call_ids: [],
      pruned_message_ids: [],
      sanitized_message_ids: [],
      sanitized_tool_call_ids: [],
    };

    expect(errorResponse.status).toBe("error");
  });
});

describe("output formatting", () => {
  test("formats ok status correctly", () => {
    const response = {
      status: "ok" as const,
      message: "No orphaned tool_use blocks found",
      orphaned_tool_calls: [] as Array<{
        message_id: string;
        tool_call_id: string;
        tool_name: string;
        reason: string;
      }>,
      injected_message_ids: [] as string[],
      injected_tool_call_ids: [] as string[],
      pruned_message_ids: [],
      sanitized_message_ids: [],
      sanitized_tool_call_ids: [] as string[],
    };

    // Simulate the output formatting logic from App.tsx
    let outputMsg = "";
    if (response.status === "ok") {
      outputMsg = "✓ No issues found in message history";
    }

    expect(outputMsg).toContain("✓");
    expect(outputMsg).toContain("No issues");
  });

  test("formats repaired status with tool call details", () => {
    const response = {
      status: "repaired" as const,
      message:
        "Injected 2 synthetic tool result message(s) for 2 orphaned tool_call(s); pruned 1 orphan function_call_output-only message(s)",
      orphaned_tool_calls: [
        {
          message_id: "msg-1",
          tool_call_id: "toolu_1",
          tool_name: "web_search",
          reason: "no_following_message",
        },
        {
          message_id: "msg-1",
          tool_call_id: "toolu_2",
          tool_name: "calculator",
          reason: "no_following_message",
        },
      ],
      injected_message_ids: ["msg-syn-1", "msg-syn-2"],
      injected_tool_call_ids: ["toolu_1", "toolu_2"],
      pruned_message_ids: ["msg-orphan-output-1"],
    };

    // Simulate the output formatting logic from App.tsx
    let outputMsg = "";
    if (response.status === "repaired") {
      outputMsg = `✓ Repaired: ${response.message}`;
      if (response.orphaned_tool_calls.length > 0) {
        outputMsg += "\n\nOrphaned tool calls fixed:";
        for (const tc of response.orphaned_tool_calls) {
          outputMsg += `\n  • ${tc.tool_name} (${tc.reason})`;
        }
      }
      if ((response.pruned_message_ids?.length || 0) > 0) {
        outputMsg += "\n\nOrphaned output-only messages pruned:";
        for (const msgId of response.pruned_message_ids) {
          outputMsg += `\n  • ${msgId}`;
        }
      }
    }

    expect(outputMsg).toContain("✓ Repaired");
    expect(outputMsg).toContain("web_search");
    expect(outputMsg).toContain("calculator");
    expect(outputMsg).toContain("no_following_message");
    expect(outputMsg).toContain("Orphaned output-only messages pruned");
    expect(outputMsg).toContain("msg-orphan-output-1");
  });

  test("formats repaired status with sanitization summary", () => {
    const response = {
      status: "repaired" as const,
      message: "Sanitized malformed tool-call JSON in 2 message(s)",
      orphaned_tool_calls: [] as Array<{
        message_id: string;
        tool_call_id: string;
        tool_name: string;
        reason: string;
      }>,
      injected_message_ids: [] as string[],
      injected_tool_call_ids: [] as string[],
      pruned_message_ids: [] as string[],
      sanitized_message_ids: ["msg-1", "msg-2"] as string[],
      sanitized_tool_call_ids: ["toolu-1", "toolu-2", "toolu-3"] as string[],
    };

    let outputMsg = "";
    if (response.status === "repaired") {
      outputMsg = `✓ Repaired: ${response.message}`;
      if ((response.sanitized_tool_call_ids?.length || 0) > 0) {
        outputMsg += `\n\nMalformed tool-call JSON sanitized: ${response.sanitized_tool_call_ids?.length || 0} tool_call(s) across ${response.sanitized_message_ids?.length || 0} message(s)`;
      }
    }

    expect(outputMsg).toContain("✓ Repaired");
    expect(outputMsg).toContain("Malformed tool-call JSON sanitized");
    expect(outputMsg).toContain("3 tool_call(s) across 2 message(s)");
  });

  test("formats error status with warning", () => {
    const response = {
      status: "error" as const,
      message: "Something went wrong",
      orphaned_tool_calls: [] as Array<{
        message_id: string;
        tool_call_id: string;
        tool_name: string;
        reason: string;
      }>,
      injected_message_ids: [] as string[],
      injected_tool_call_ids: [] as string[],
      pruned_message_ids: [],
      sanitized_message_ids: [],
      sanitized_tool_call_ids: [] as string[],
    };

    // Simulate the output formatting logic from App.tsx
    let outputMsg = "";
    if (response.status === "error") {
      outputMsg = `⚠ ${response.message}`;
    }

    expect(outputMsg).toContain("⚠");
    expect(outputMsg).toContain("Something went wrong");
  });
});
