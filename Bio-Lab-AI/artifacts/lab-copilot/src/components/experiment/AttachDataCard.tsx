import { useState } from "react";
import { apiFetch } from "@/lib/apiFetch";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { UploadCloud, Loader2, FlaskConical } from "lucide-react";
import { PlateGridPickerDialog, type ManualPlateSelection } from "./PlateGridPickerDialog";
import type { WellRole } from "@/lib/plateMetrics";

/**
 * Upload plate data to an experiment that was created design-first (from a goal /
 * protocol, before any data existed). Posts to POST /api/experiments/:id/data,
 * which re-parses the file and clears stale AI analysis. On success the parent
 * refetches; quantifying the data is a separate, explicit "Bioalyze" action —
 * nothing here runs analysis automatically.
 */
export function AttachDataCard({
  experimentId,
  onAttached,
}: {
  experimentId: number;
  onAttached: () => void;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [pendingImport, setPendingImport] = useState<{ file: File; b64: string; preview: string[][] } | null>(null);

  const attachFile = async (
    file: File,
    b64: string,
    selection?: ManualPlateSelection,
    controlRoles?: Record<string, WellRole>,
  ) => {
    const resp = await apiFetch(`/api/experiments/${experimentId}/data`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file_content_b64: b64,
        file_name: file.name,
        ...(selection ? { plate_selection: selection } : {}),
        ...(controlRoles && Object.keys(controlRoles).length ? { control_roles: controlRoles } : {}),
      }),
    });
    if (!resp.ok) {
      const error = await resp.json().catch(() => ({ error: "Upload failed" }));
      throw new Error(error.error || "Upload failed");
    }
  };

  const handleFile = async (file: File) => {
    const lower = file.name.toLowerCase();
    // Legacy .xls can't be read server-side — steer the user to re-export.
    if (lower.endsWith(".xls") && !lower.endsWith(".xlsx")) {
      toast({
        title: "Legacy .xls not supported",
        description: "Re-export/Save As .xlsx from your plate-reader software or Excel, then upload that.",
        variant: "destructive",
      });
      return;
    }
    if (!/\.(xlsx|csv|tsv|txt)$/.test(lower)) {
      toast({
        title: "Unsupported file type",
        description: "Upload a plate-reader .xlsx, CSV, TSV, or TXT export.",
        variant: "destructive",
      });
      return;
    }

    setBusy(true);
    try {
      const b64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve((reader.result as string).split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      const detection = await apiFetch("/api/experiments/parse-plate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_content_b64: b64, file_name: file.name }),
      });
      if (!detection.ok) {
        const error = await detection.json().catch(() => ({ error: "Upload failed" })) as { error?: string; code?: string; preview?: string[][] };
        if (error.code === "PLATE_GRID_NOT_FOUND" && Array.isArray(error.preview)) {
          setPendingImport({ file, b64, preview: error.preview });
          return;
        }
        throw new Error(error.error || "Upload failed");
      }

      await attachFile(file, b64);

      toast({ title: "Plate imported", description: "The 8×12 grid was detected and its deterministic metrics are ready." });
      onAttached();
    } catch (err) {
      toast({
        title: "Couldn't attach data",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
    <PlateGridPickerDialog
      open={Boolean(pendingImport)}
      filename={pendingImport?.file.name ?? ""}
      preview={pendingImport?.preview ?? []}
      onCancel={() => setPendingImport(null)}
      onConfirm={async (selection, roles) => {
        if (!pendingImport) return;
        setBusy(true);
        try {
          await attachFile(pendingImport.file, pendingImport.b64, selection, roles);
          setPendingImport(null);
          toast({ title: "Plate imported", description: "The selected grid and control labels are saved." });
          onAttached();
        } catch (error) {
          toast({ title: "Couldn't attach data", description: error instanceof Error ? error.message : String(error), variant: "destructive" });
        } finally {
          setBusy(false);
        }
      }}
    />
    <Card className="border-dashed border-primary/40 bg-primary/5">
      <CardHeader className="py-4">
        <CardTitle className="text-lg flex items-center gap-2">
          <FlaskConical className="h-5 w-5 text-primary" />
          Add plate data
        </CardTitle>
        <CardDescription>
          This experiment has no results yet. Upload an export from any 96-well plate reader; Bioalyzer will detect the grid or let you select it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <label
          className={`block border-2 border-dashed rounded-lg p-8 flex flex-col items-center justify-center transition-colors ${
            busy ? "opacity-60 pointer-events-none" : "cursor-pointer"
          } ${dragging ? "border-primary bg-primary/10" : "border-primary/30 hover:border-primary/60 hover:bg-primary/5"}`}
          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragging(true); }}
          onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); setDragging(true); }}
          onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); setDragging(false); }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setDragging(false);
            const f = e.dataTransfer.files[0];
            if (f) handleFile(f);
          }}
        >
          {busy ? (
            <Loader2 className="h-8 w-8 text-primary mb-3 animate-spin" />
          ) : (
            <UploadCloud className={`h-8 w-8 text-primary mb-3 transition-transform ${dragging ? "scale-125" : ""}`} />
          )}
          <div className="text-sm font-medium text-foreground mb-1">
            {busy ? "Parsing plate data…" : dragging ? "Release to upload" : "Drop any 96-well plate-reader export here"}
          </div>
          <div className="text-xs text-muted-foreground mb-4">.xlsx, or CSV / TSV / TXT</div>
          <input
            type="file"
            accept=".xlsx,.csv,.tsv,.txt"
            className="hidden"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
            }}
          />
          <Button type="button" variant="outline" size="sm" asChild disabled={busy}>
            <span>Browse file</span>
          </Button>
        </label>
      </CardContent>
    </Card>
    </>
  );
}
