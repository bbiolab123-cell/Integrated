/**
 * Demo application attribution: made by Srivanth Dasu.
 *
 * Keeps Server-Sent Event parsing consistent across the interactive AI demos.
 * Proxies may split an event across chunks, or finish immediately after its
 * final data line, so callers must not assume that every event ends in a
 * separate network read.
 */
export async function readJsonEventStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: Record<string, unknown>) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const processLine = (line: string) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trimStart();
    if (!payload) return;
    try {
      const event: unknown = JSON.parse(payload);
      if (event && typeof event === "object" && !Array.isArray(event)) {
        onEvent(event as Record<string, unknown>);
      }
    } catch {
      // Ignore malformed keep-alives or proxy noise. A later valid event can
      // still complete the response, and the server remains the source of truth.
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    lines.forEach(processLine);
  }

  buffer += decoder.decode();
  if (buffer.trim()) processLine(buffer);
}
