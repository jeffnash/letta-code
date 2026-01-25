import { describe, expect, test } from "bun:test";
import { determineKeyboardAction } from "../../cli/components/agentSelectorKeyboard";
import { getFooterHints } from "../../cli/components/AgentSelector";

/**
 * Tests for AgentSelector keyboard handling logic.
 *
 * The key behaviors being tested:
 * - '/' enters search mode on list tabs
 * - While in search mode, all characters (including 'n') add to search
 * - 'N' creates a new agent when NOT in search mode
 * - Pinned tab does not support search
 * - Modifier keys (ctrl/meta) are passed through
 */

describe("AgentSelector keyboard handling", () => {
  describe("entering search mode", () => {
    test("'/' enters search mode on letta-code tab", () => {
      const action = determineKeyboardAction("/", {}, {
        activeTab: "letta-code",
        isSearchMode: false,
      });
      expect(action).toEqual({ type: "enter_search_mode" });
    });

    test("'/' enters search mode on all tab", () => {
      const action = determineKeyboardAction("/", {}, {
        activeTab: "all",
        isSearchMode: false,
      });
      expect(action).toEqual({ type: "enter_search_mode" });
    });

    test("'/' does nothing on pinned tab (no search support)", () => {
      const action = determineKeyboardAction("/", {}, {
        activeTab: "pinned",
        isSearchMode: false,
      });
      expect(action).toEqual({ type: "none" });
    });
  });

  describe("search mode behavior", () => {
    test("typing characters adds to search", () => {
      const action = determineKeyboardAction("a", {}, {
        activeTab: "letta-code",
        isSearchMode: true,
      });
      expect(action).toEqual({ type: "add_to_search", char: "a" });
    });

    test("typing 'n' adds to search (not new agent)", () => {
      const action = determineKeyboardAction("n", {}, {
        activeTab: "letta-code",
        isSearchMode: true,
      });
      expect(action).toEqual({ type: "add_to_search", char: "n" });
    });

    test("typing 'N' adds to search (not new agent)", () => {
      const action = determineKeyboardAction("N", {}, {
        activeTab: "all",
        isSearchMode: true,
      });
      expect(action).toEqual({ type: "add_to_search", char: "N" });
    });

    test("Ctrl+key passes through (returns none)", () => {
      const action = determineKeyboardAction("c", { ctrl: true }, {
        activeTab: "letta-code",
        isSearchMode: true,
      });
      expect(action).toEqual({ type: "none" });
    });

    test("Meta+key passes through (returns none)", () => {
      const action = determineKeyboardAction("v", { meta: true }, {
        activeTab: "all",
        isSearchMode: true,
      });
      expect(action).toEqual({ type: "none" });
    });

    test("empty string returns none", () => {
      const action = determineKeyboardAction("", {}, {
        activeTab: "letta-code",
        isSearchMode: true,
      });
      expect(action).toEqual({ type: "none" });
    });
  });

  describe("N key behavior (not in search mode)", () => {
    test("'n' creates new agent on pinned tab", () => {
      const action = determineKeyboardAction("n", {}, {
        activeTab: "pinned",
        isSearchMode: false,
      });
      expect(action).toEqual({ type: "create_new_agent" });
    });

    test("'N' creates new agent on letta-code tab", () => {
      const action = determineKeyboardAction("N", {}, {
        activeTab: "letta-code",
        isSearchMode: false,
      });
      expect(action).toEqual({ type: "create_new_agent" });
    });

    test("'n' creates new agent on all tab", () => {
      const action = determineKeyboardAction("n", {}, {
        activeTab: "all",
        isSearchMode: false,
      });
      expect(action).toEqual({ type: "create_new_agent" });
    });
  });

  describe("real-world scenarios", () => {
    test("searching for 'Nancy' works correctly", () => {
      // User presses '/' to enter search mode, then types "Nancy"
      const enterSearch = determineKeyboardAction("/", {}, {
        activeTab: "letta-code",
        isSearchMode: false,
      });
      expect(enterSearch).toEqual({ type: "enter_search_mode" });

      // Now in search mode, type "Nancy"
      const chars = ["N", "a", "n", "c", "y"];
      for (const char of chars) {
        const action = determineKeyboardAction(char, {}, {
          activeTab: "letta-code",
          isSearchMode: true,
        });
        expect(action).toEqual({ type: "add_to_search", char });
      }
    });

    test("searching for 'nathan' starting with n works", () => {
      // Enter search mode first
      const enterSearch = determineKeyboardAction("/", {}, {
        activeTab: "all",
        isSearchMode: false,
      });
      expect(enterSearch).toEqual({ type: "enter_search_mode" });

      // Type 'n' - should add to search, not create agent
      const action = determineKeyboardAction("n", {}, {
        activeTab: "all",
        isSearchMode: true,
      });
      expect(action).toEqual({ type: "add_to_search", char: "n" });
    });

    test("can create new agent when not in search mode", () => {
      const action = determineKeyboardAction("N", {}, {
        activeTab: "letta-code",
        isSearchMode: false,
      });
      expect(action).toEqual({ type: "create_new_agent" });
    });

    test("'/' while already in search mode adds to search", () => {
      // User might type a path like "src/components"
      const action = determineKeyboardAction("/", {}, {
        activeTab: "letta-code",
        isSearchMode: true,
      });
      expect(action).toEqual({ type: "add_to_search", char: "/" });
    });

    test("other characters return none when not in search mode", () => {
      const action = determineKeyboardAction("a", {}, {
        activeTab: "letta-code",
        isSearchMode: false,
      });
      expect(action).toEqual({ type: "none" });
    });
  });
});

describe("getFooterHints", () => {
  test("shows search hints when in search mode", () => {
    const hints = getFooterHints(true, "letta-code", "", true);
    expect(hints).toBe("Enter search · ↑↓ navigate · Esc cancel");
  });

  test("shows '/ search' on list tabs when not in search mode", () => {
    const hints = getFooterHints(false, "letta-code", "", true);
    expect(hints).toContain("/ search");
    expect(hints).not.toContain("P unpin");
  });

  test("shows 'P unpin' on pinned tab", () => {
    const hints = getFooterHints(false, "pinned", "", true);
    expect(hints).toContain("P unpin");
    expect(hints).not.toContain("/ search");
  });

  test("shows 'N new' when hasCreateNewAgent is true", () => {
    const hints = getFooterHints(false, "letta-code", "", true);
    expect(hints).toContain("N new");
  });

  test("hides 'N new' when hasCreateNewAgent is false", () => {
    const hints = getFooterHints(false, "letta-code", "", false);
    expect(hints).not.toContain("N new");
  });

  test("shows 'Esc clear' when there is an active query", () => {
    const hints = getFooterHints(false, "letta-code", "some query", true);
    expect(hints).toContain("Esc clear");
    expect(hints).not.toContain("Esc cancel");
  });

  test("shows 'Esc cancel' when there is no active query", () => {
    const hints = getFooterHints(false, "letta-code", "", true);
    expect(hints).toContain("Esc cancel");
    expect(hints).not.toContain("Esc clear");
  });

  test("shows 'Esc cancel' on pinned tab even with active query", () => {
    const hints = getFooterHints(false, "pinned", "some query", true);
    expect(hints).toContain("Esc cancel");
    expect(hints).not.toContain("Esc clear");
  });
});
