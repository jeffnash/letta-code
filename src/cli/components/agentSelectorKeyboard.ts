/**
 * Keyboard handling logic for AgentSelector component.
 * Extracted for testability and to prevent drift between component and tests.
 */

export type TabId = "pinned" | "letta-code" | "all";

export interface KeyboardState {
  activeTab: TabId;
  isSearchMode: boolean;
}

export interface KeyEvent {
  ctrl?: boolean;
  meta?: boolean;
}

export type KeyboardAction =
  | { type: "create_new_agent" }
  | { type: "enter_search_mode" }
  | { type: "add_to_search"; char: string }
  | { type: "none" };

/**
 * Determines what action to take for a given key input.
 *
 * When in search mode:
 * - All printable characters add to search input
 * - Modifier keys (ctrl/meta) are ignored (passed through for other handlers)
 *
 * When not in search mode:
 * - '/' enters search mode (on list tabs only)
 * - 'n'/'N' creates a new agent
 * - Other keys return 'none' (handled elsewhere: arrows, tab, escape, etc.)
 */
export function determineKeyboardAction(
  input: string,
  key: KeyEvent,
  state: KeyboardState,
): KeyboardAction {
  if (key.ctrl || key.meta) {
    return { type: "none" };
  }

  const supportsSearch = state.activeTab !== "pinned";

  if (state.isSearchMode && supportsSearch) {
    return input ? { type: "add_to_search", char: input } : { type: "none" };
  }

  switch (input) {
    case "/":
      return supportsSearch ? { type: "enter_search_mode" } : { type: "none" };
    case "n":
    case "N":
      return { type: "create_new_agent" };
    default:
      return { type: "none" };
  }
}
