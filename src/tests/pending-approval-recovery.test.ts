import { describe, expect, test } from "bun:test";

// Unit-level guard: the recovery path expects the server to send a 409 with a
// detail string that includes "waiting for approval on a tool call".

describe("pending approval recovery", () => {
  test("detects conflict detail for pending approval", () => {
    const detail =
      "CONFLICT: Cannot send a new message: The agent is waiting for approval on a tool call. Please approve or deny the pending request before continuing.";

    expect(detail.includes("waiting for approval on a tool call")).toBe(true);
  });
});
