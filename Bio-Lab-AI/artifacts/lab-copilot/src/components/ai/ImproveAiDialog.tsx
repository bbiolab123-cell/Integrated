import { useEffect, useState } from "react";
import { Check, Loader2, PencilLine } from "lucide-react";
import { apiFetch } from "@/lib/apiFetch";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

type ImproveAiDialogProps = {
  requestId?: string | null;
  output: string;
  taskLabel?: string;
  compact?: boolean;
};

export function ImproveAiDialog({ requestId, output, taskLabel = "response", compact = false }: ImproveAiDialogProps) {
  const [open, setOpen] = useState(false);
  const [corrected, setCorrected] = useState(output);
  const [rating, setRating] = useState(5);
  const [approve, setApprove] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setCorrected(output);
    setApprove(false);
    setSaved(false);
    setError("");
  }, [open, output]);

  if (!requestId || !output.trim()) return null;
  const hasCorrection = corrected.trim() !== output.trim();

  const submit = async () => {
    setSaving(true);
    setError("");
    try {
      const response = await apiFetch("/api/ai/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request_id: requestId,
          rating,
          corrected_output: corrected.trim(),
          approved_for_training: approve,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? "Could not save this correction.");
      }
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save this correction.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size={compact ? "sm" : "default"} className="gap-2">
          <PencilLine className="h-3.5 w-3.5" />
          Improve AI
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Improve this {taskLabel}</DialogTitle>
          <DialogDescription>
            Rate the answer and make at least one human correction before approving it. Unedited model output is never used for training.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <div className="mb-2 text-sm font-medium">Quality rating</div>
            <div className="flex gap-2">
              {[1, 2, 3, 4, 5].map((score) => (
                <Button
                  key={score}
                  type="button"
                  variant={rating === score ? "default" : "outline"}
                  size="sm"
                  onClick={() => setRating(score)}
                >
                  {score}
                </Button>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-2 text-sm font-medium">Scientist-reviewed answer</div>
            <Textarea
              value={corrected}
              onChange={(event) => {
                const value = event.target.value;
                setCorrected(value);
                if (value.trim() === output.trim()) setApprove(false);
              }}
              className="min-h-64 font-mono text-xs"
            />
          </div>

          <label className="flex items-start gap-3 rounded-md border p-3 text-sm">
            <Checkbox
              checked={approve}
              disabled={!hasCorrection}
              onCheckedChange={(checked) => setApprove(checked === true)}
            />
            <span>
              Approve this corrected answer for the private Bio-Lab AI training export. Remove names, filenames, or other identifying details first.
            </span>
          </label>

          {error && <p className="text-sm text-destructive">{error}</p>}
          {saved && <p className="flex items-center gap-2 text-sm text-emerald-600"><Check className="h-4 w-4" /> {approve ? "Saved for the approved training set." : "Rating and review saved; not approved for training."}</p>}
        </div>

        <DialogFooter>
          <Button type="button" onClick={submit} disabled={saving || !corrected.trim()}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save review
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
