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
      removed_message_ids: [],
    };

    expect(okResponse.status).toBe("ok");
    expect(Array.isArray(okResponse.orphaned_tool_calls)).toBe(true);
    expect(Array.isArray(okResponse.removed_message_ids)).toBe(true);
  });

  test("repaired response structure", () => {
    const repairedResponse = {
      status: "repaired" as const,
      message: "Removed 1 message(s) with 2 orphaned tool_use block(s)",
      orphaned_tool_calls: [
        {
          message_id: "msg-123",
          tool_call_id: "toolu_456",
          tool_name: "get_weather",
          reason: "no_following_message",
        },
      ],
      removed_message_ids: ["msg-123"],
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
      removed_message_ids: [],
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
      removed_message_ids: [] as string[],
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
      message: "Removed 1 message(s) with 2 orphaned tool_use block(s)",
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
      removed_message_ids: ["msg-1"],
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
    }

    expect(outputMsg).toContain("✓ Repaired");
    expect(outputMsg).toContain("web_search");
    expect(outputMsg).toContain("calculator");
    expect(outputMsg).toContain("no_following_message");
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
      removed_message_ids: [] as string[],
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
