import { useState, useEffect, useRef } from "react";
import { apiFetch } from "@/lib/apiFetch";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Send, Bot, User, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ImproveAiDialog } from "@/components/ai/ImproveAiDialog";

interface ChatMessage {
  id: number;
  role: string;
  content: string;
  aiRequestId?: string | null;
}

const STARTERS = [
  "What does the data across this project tell us so far?",
  "What should my next experiment be, given everything here?",
  "Are there contradictions or patterns between these experiments?",
];

export function ProjectChat({ projectId }: { projectId: number }) {
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [assistantBuffer, setAssistantBuffer] = useState("");
  const [chatError, setChatError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const queryKey = ["project-messages", projectId];

  const { data: messages = [], isLoading } = useQuery<ChatMessage[]>({
    queryKey,
    queryFn: () => apiFetch(`/api/projects/${projectId}/messages`).then((r) => r.json()),
    enabled: !!projectId,
  });

  const scrollToBottom = () => {
    const vp = scrollRef.current?.querySelector("[data-radix-scroll-area-viewport]");
    if (vp) vp.scrollTop = vp.scrollHeight;
  };
  useEffect(() => { scrollToBottom(); }, [messages, assistantBuffer]);

  const send = async (text: string) => {
    const content = text.trim();
    if (!content || isStreaming) return;
    setInput("");
    setIsStreaming(true);
    setAssistantBuffer("");
    setChatError(null);

    queryClient.setQueryData(queryKey, (old: ChatMessage[] | undefined) => [
      ...(old || []),
      { id: Date.now(), role: "user", content },
    ]);

    try {
      const response = await apiFetch(`/api/projects/${projectId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error ?? "Failed to send message");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("No reader");
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
            try {
              const data = JSON.parse(line.slice(6));
              if (data.content) setAssistantBuffer((p) => p + data.content);
              if (data.error) setChatError(data.error);
              if (data.done) queryClient.invalidateQueries({ queryKey });
            } catch (err) {
              console.error("Parse error", err);
            }
          }
        }
      }
    } catch (err) {
      console.error("Project chat error:", err);
      setChatError(err instanceof Error ? err.message : "Couldn't reach the AI. Check your connection and try again.");
    } finally {
      setIsStreaming(false);
      setAssistantBuffer("");
      queryClient.invalidateQueries({ queryKey });
    }
  };

  return (
    <div className="flex flex-col h-[520px] rounded-md border bg-card">
      <div className="p-4 border-b bg-muted/50 flex items-center gap-2">
        <Sparkles className="h-5 w-5 text-primary" />
        <h3 className="font-semibold">Project Copilot</h3>
        <span className="text-xs text-muted-foreground ml-auto">grounded in this project's goal + experiments</span>
      </div>

      <ScrollArea ref={scrollRef} className="flex-1 p-4">
        <div className="flex flex-col gap-4">
          {isLoading && (
            <div className="flex justify-center p-4">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )}

          {!isLoading && messages.length === 0 && (
            <div className="text-center p-6 text-muted-foreground text-sm space-y-3">
              <p>Ask the copilot about the whole project — it sees the goal and every experiment in it.</p>
              <div className="flex flex-col gap-2">
                {STARTERS.map((s) => (
                  <button
                    key={s}
                    onClick={() => send(s)}
                    className="text-xs px-3 py-2 rounded-md border border-primary/30 text-primary/80 hover:bg-primary/10 hover:text-primary transition-colors text-left"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg) => (
            <div key={msg.id} className={`flex gap-3 ${msg.role === "user" ? "flex-row-reverse" : ""}`}>
              <div className={`flex-shrink-0 h-8 w-8 rounded-full flex items-center justify-center ${msg.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted text-foreground"}`}>
                {msg.role === "user" ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
              </div>
              <div className={`rounded-lg px-4 py-2 max-w-[80%] text-sm ${msg.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted text-foreground"}`}>
                {msg.role === "user" ? (
                  <div className="whitespace-pre-wrap">{msg.content}</div>
                ) : (
                  <div className="space-y-3">
                    <div className="prose prose-sm dark:prose-invert max-w-none break-words">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                    </div>
                    <ImproveAiDialog requestId={msg.aiRequestId} output={msg.content} taskLabel="project-chat answer" compact />
                  </div>
                )}
              </div>
            </div>
          ))}

          {isStreaming && (
            <div className="flex gap-3">
              <div className="flex-shrink-0 h-8 w-8 rounded-full bg-muted flex items-center justify-center">
                <Bot className="h-4 w-4 text-foreground" />
              </div>
              <div className="rounded-lg px-4 py-2 max-w-[80%] bg-muted text-foreground text-sm">
                <div className="prose prose-sm dark:prose-invert max-w-none break-words">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{assistantBuffer}</ReactMarkdown>
                </div>
                <span className="inline-block w-1.5 h-4 ml-1 bg-primary animate-pulse align-middle" />
              </div>
            </div>
          )}

          {chatError && !isStreaming && (
            <div className="flex gap-3">
              <div className="flex-shrink-0 h-8 w-8 rounded-full bg-destructive/15 flex items-center justify-center">
                <Bot className="h-4 w-4 text-destructive" />
              </div>
              <div className="rounded-lg px-4 py-2 max-w-[80%] bg-destructive/10 border border-destructive/30 text-destructive text-sm">
                {chatError}
              </div>
            </div>
          )}
        </div>
      </ScrollArea>

      <div className="p-4 border-t bg-card">
        <form
          onSubmit={(e) => { e.preventDefault(); send(input); }}
          className="flex gap-2"
        >
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about this project…"
            disabled={isStreaming}
            className="flex-1"
          />
          <Button type="submit" disabled={isStreaming || !input.trim()}>
            <Send className="h-4 w-4" />
          </Button>
        </form>
      </div>
    </div>
  );
}
