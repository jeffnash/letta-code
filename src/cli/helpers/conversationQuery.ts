/**
 * Helper for building conversation query strings for ADE and API URLs.
 *
 * The "default" sentinel value indicates the agent's primary message history
 * (no explicit conversation), so we should omit the conversation query parameter
 * in that case.
 */

/** The sentinel value that indicates the agent's default/primary conversation */
export const DEFAULT_CONVERSATION_SENTINEL = "default";

/**
 * Returns the appropriate conversation query string for URL building.
 *
 * @param conversationId - The conversation ID (may be the default sentinel)
 * @param paramName - The query parameter name (default: "conversation")
 * @returns Query string like "?conversation=abc123" or "" if default/missing
 *
 * @example
 * // For ADE URL: https://app.letta.com/agents/123
 * getConversationQueryString("abc123")  // "?conversation=abc123"
 * getConversationQueryString("default") // ""
 * getConversationQueryString(undefined) // ""
 *
 * @example
 * // For API URL with different param name
 * getConversationQueryString("abc123", "conversation_id")  // "?conversation_id=abc123"
 */
export function getConversationQueryString(
  conversationId: string | undefined | null,
  paramName = "conversation",
): string {
  if (!conversationId || conversationId === DEFAULT_CONVERSATION_SENTINEL) {
    return "";
  }
  return `?${paramName}=${encodeURIComponent(conversationId)}`;
}
