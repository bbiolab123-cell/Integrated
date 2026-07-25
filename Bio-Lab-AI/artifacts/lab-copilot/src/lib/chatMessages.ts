// Chat components render whatever the API returns straight into ReactMarkdown.
// If a request ever comes back malformed (a proxy error page instead of JSON,
// a backend bug returning the wrong shape, a stale cache entry), mapping over
// it directly would crash the whole chat panel. Filter to only well-shaped
// messages instead, so a bad entry gets silently dropped rather than taking
// down the conversation.
export interface SafeChatMessage {
  id: number | string;
  role: string;
  content: string;
}

export function sanitizeChatMessages(value: unknown): SafeChatMessage[] {
  if (!Array.isArray(value)) return [];
  return value.filter((m): m is SafeChatMessage => {
    if (!m || typeof m !== "object") return false;
    const record = m as Record<string, unknown>;
    return (
      (typeof record.id === "number" || typeof record.id === "string") &&
      typeof record.role === "string" &&
      typeof record.content === "string"
    );
  });
}
