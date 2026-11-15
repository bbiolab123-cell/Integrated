import { useState } from "react";
import { Link } from "wouter";
import { apiFetch } from "@/lib/apiFetch";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { UploadCloud, Loader2 } from "lucide-react";
import { PlateGridPickerDialog, type ManualPlateSelection } from "./PlateGridPickerDialog";

type PendingFile = { file: File; b64: string };
type ImportChoice = PendingFile & (
  | { kind: "sheet"; sheets: string[] }
  | { kind: "grid"; preview: string[][]; sheetName?: string }
);

export function AttachDataCard({
  experimentId,
  onAttached,
}: {
  experimentId?: number;
  onAttached: (id: number) => void;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<ImportChoice | null>(null);

  const attachFile = async ({ file, b64 }: PendingFile, sheetName?: string, selection?: ManualPlateSelection) => {
    const response = await apiFetch(experimentId ? `/api/experiments/${experimentId}/data` : "/api/experiments/plate-run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file_content_b64: b64,
        file_name: file.name,
        plate_only: true,
        sheet_name: sheetName,
        plate_selection: selection,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (payload.code === "PLATE_SHEET_CHOICE" && Array.isArray(payload.sheets)) {
        setPending({ kind: "sheet", file, b64, sheets: payload.sheets });
        return;
      }
      if (!selection && payload.code === "PLATE_GRID_NOT_FOUND" && Array.isArray(payload.preview)) {
        setPending({ kind: "grid", file, b64, preview: payload.preview, sheetName: payload.sheet_name ?? sheetName });
        return;
      }
      throw new Error(payload.error || "We could not import this file.");
    }
    setPending(null);
    onAttached(payload.id);
    toast({ title: "Plate imported", description: "Review and confirm the plate layout." });
  };

  const runUpload = async (upload: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await upload();
    } catch (err) {
      setPending(null);
      setError(err instanceof Error ? err.message : "We could not import this file.");
    } finally {
      setBusy(false);
    }
  };

  const handleFile = (file: File) => runUpload(async () => {
    if (!/\.(xlsx|csv|tsv|txt)$/i.test(file.name)) {
      throw new Error("Export the plate as XLSX, CSV, TSV, or TXT and try again.");
    }
    const b64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve((reader.result as string).split(",")[1]);
      reader.onerror = () => reject(new Error("We could not read the selected file."));
      reader.readAsDataURL(file);
    });
    await attachFile({ file, b64 });
  });

  const grid = pending?.kind === "grid" ? pending : null;
  const sheetChoice = pending?.kind === "sheet" ? pending : null;

  return (
    <>
      <Dialog open={Boolean(sheetChoice)} onOpenChange={(open) => { if (!open && !busy) setPending(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Choose a worksheet</DialogTitle>
            <DialogDescription>Select the sheet that contains the plate you want to review.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap gap-2">
            {sheetChoice?.sheets.map((name) => (
              <Button key={name} type="button" variant="outline" disabled={busy} onClick={() => runUpload(() => attachFile(sheetChoice, name))}>
                {name}
              </Button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
      <PlateGridPickerDialog
        open={Boolean(grid)}
        filename={grid?.sheetName ?? grid?.file.name ?? ""}
        preview={grid?.preview ?? []}
        busy={busy}
        onCancel={() => { if (!busy) setPending(null); }}
        onConfirm={(selection) => { if (grid) void runUpload(() => attachFile(grid, grid.sheetName, selection)); }}
      />
      <Card className="border-dashed border-primary/40 bg-primary/5">
        <CardHeader className="py-4">
          <CardTitle>Upload plate file</CardTitle>
          <CardDescription>Upload a BioTek Synergy H1 or Gen5 export.</CardDescription>
        </CardHeader>
        <CardContent>
          <label
            className={`flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 transition-colors focus-within:ring-2 focus-within:ring-ring ${busy ? "opacity-60" : "cursor-pointer"} ${dragging ? "border-primary bg-primary/10" : "border-primary/30 hover:bg-primary/5"}`}
            onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              const file = event.dataTransfer.files[0];
              if (file) void handleFile(file);
            }}
          >
            {busy ? <Loader2 className="mb-3 size-8 animate-spin text-primary" /> : <UploadCloud className="mb-3 size-8 text-primary" />}
            <span className="mb-1 text-sm font-medium" aria-live="polite">{busy ? "Importing plate…" : dragging ? "Release to upload" : "Drop a plate file or browse"}</span>
            <span className="text-xs text-muted-foreground">XLSX, CSV, TSV, TXT</span>
            <input
              type="file"
              accept=".xlsx,.csv,.tsv,.txt"
              className="sr-only"
              aria-label="Upload plate file"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void handleFile(file);
              }}
            />
          </label>
          {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
          <p className="mt-3 text-xs text-muted-foreground">Do not upload unpublished or sensitive data. You can request deletion through the <Link className="underline" href="/privacy">privacy page</Link>.</p>
        </CardContent>
      </Card>
    </>
  );
}
