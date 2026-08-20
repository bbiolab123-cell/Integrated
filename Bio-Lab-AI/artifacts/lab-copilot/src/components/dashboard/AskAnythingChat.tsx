import { useState } from "react";
import { apiFetch } from "@/lib/apiFetch";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { AlertCircle, Send, Sparkles } from "lucide-react";
import { motion } from "framer-motion";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ImproveAiDialog } from "@/components/ai/ImproveAiDialog";

// The system prompt lives on the server. A client-supplied one was being sent
// here and (correctly) ignored by the API — a caller must not be able to
// rewrite the model's instructions.

interface Turn {
  role: "user" | "assistant";
  content: string;
}

export function AskAnythingChat() {
  const [message, setMessage] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [response, setResponse] = useState("");
  const [error, setError] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);

  const sendMessage = async () => {
    const content = message.trim();
    if (!content || isStreaming) return;

    // Send the transcript so far, then show the question immediately.
    const priorTurns = response
      ? [...turns, { role: "assistant" as const, content: response }]
      : turns;

    setIsStreaming(true);
    setTurns([...priorTurns, { role: "user", content }]);
    setMessage("");
    setResponse("");
    setError("");
    setRequestId(null);

    try {
      const res = await apiFetch("/api/ai/general-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: content, history: priorTurns }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? "The AI request failed. Please try again.");
      }
      if (!res.body) throw new Error("No response body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = JSON.parse(line.slice(6));
            if (data.content) setResponse((prev) => prev + data.content);
            if (data.error) setError(data.error);
            if (data.request_id) setRequestId(data.request_id);
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "The AI request failed. Please try again.");
    } finally {
      setIsStreaming(false);
    }
  };

  const isEmpty = !response && !isStreaming && !error && turns.length === 0;

  return (
    <Card className="surface-panel rounded-lg border-primary/20">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            <CardTitle>Ask Anything</CardTitle>
          </div>
          <span className="rounded-full border border-border bg-background/60 px-2.5 py-1 text-xs text-muted-foreground">
            Rate limited
          </span>
        </div>
        <p className="text-sm text-muted-foreground">Biotech questions, grounded in your logged experiments</p>
      </CardHeader>
      <CardContent className="space-y-4">
        <Textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Ask about your results so far, a protocol, or any biology question…"
          className="min-h-[88px] resize-none"
        />
        <div className="flex justify-end">
          <Button onClick={sendMessage} disabled={isStreaming || !message.trim()} className="gap-2">
            <Send className="h-4 w-4" />
            Send
          </Button>
        </div>
        <div className="max-h-64 overflow-auto rounded-lg border bg-muted/20 p-4 text-sm leading-relaxed">
          {isEmpty ? (
            <span className="text-muted-foreground">Your response will appear here.</span>
          ) : error ? (
            <div className="flex items-start gap-2 text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          ) : (
            <>
              {turns.map((turn, index) => (
                <div key={index} className={turn.role === "user" ? "mb-3" : "mb-3 prose prose-sm dark:prose-invert max-w-none break-words"}>
                  {turn.role === "user" ? (
                    <p className="font-medium text-foreground">{turn.content}</p>
                  ) : (
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{turn.content}</ReactMarkdown>
                  )}
                </div>
              ))}
              <div className="prose prose-sm dark:prose-invert max-w-none break-words">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {response || ""}
                </ReactMarkdown>
              </div>
              {isStreaming && (
                <motion.span
                  className="inline-block w-2 h-4 bg-primary ml-1 align-middle"
                  animate={{ opacity: [1, 0] }}
                  transition={{ repeat: Infinity, duration: 0.6 }}
                />
              )}
              {!isStreaming && <div className="mt-4"><ImproveAiDialog requestId={requestId} output={response} taskLabel="general answer" compact /></div>}
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
