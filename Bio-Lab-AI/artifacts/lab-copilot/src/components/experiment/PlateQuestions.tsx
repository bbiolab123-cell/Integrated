import { useState, type FormEvent } from "react";
import type { PlateResults } from "@workspace/plate-analysis";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { DoseResponseResult } from "@/components/PlateRunResults";
import { apiFetch } from "@/lib/apiFetch";

export function PlateQuestions({ id }: { id: number }) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [chart, setChart] = useState<PlateResults | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const ask = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!question.trim() || busy) return;
    setBusy(true);
    setAnswer("");
    setError("");
    setChart(null);
    try {
      const response = await apiFetch(`/api/experiments/${id}/quantify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not answer this question.");
      setAnswer(payload.answer);
      setChart(payload.chart?.type === "dose_response" ? payload.chart.results : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not answer this question.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Ask about this plate</CardTitle>
        <CardDescription>Ask for the potency, control quality, or a normalized value such as well A3.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <form className="flex gap-2" onSubmit={ask}>
          <Input aria-label="Plate question" placeholder="What is the IC50?" value={question} maxLength={2000} onChange={(event) => setQuestion(event.target.value)} />
          <Button type="submit" disabled={!question.trim() || busy}>{busy && <Loader2 className="animate-spin" />} Ask</Button>
        </form>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {answer && <p role="status" className="whitespace-pre-wrap text-sm">{answer}</p>}
        {chart?.fit && <DoseResponseResult results={chart} showHeadline={false} />}
      </CardContent>
    </Card>
  );
}
