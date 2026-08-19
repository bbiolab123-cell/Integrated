import { useEffect, useState } from "react";
import { useParams } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Atom, FlaskConical, Link2Off } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PlateHeatmap } from "@/components/PlateHeatmap";
import { apiFetch } from "@/lib/apiFetch";
import type { WellRole } from "@/lib/plateMetrics";

// A read-only view of one experiment, opened from a share link by someone who
// may not have an account. Deliberately has no chat, no editing, and no
// navigation into the rest of the workspace — everything it can show arrives in
// the single public payload.

interface SharedPayload {
  name: string;
  date: string;
  assay_type: string;
  instrument: string;
  status: string;
  notes: string | null;
  plate_data: {
    _type?: string;
    wells?: { well: string; row: string; col: number; value: number | null; status: "ok" | "blank" | "high" | "low"; cv_pct: number | null }[];
    stats?: { mean: number | null; sd: number | null; cv_pct: number | null; min: number | null; max: number | null; blank_count: number; well_count: number };
    metadata?: { wavelength?: string | null } | null;
  } | null;
  control_summary: { zprime?: number | null; signal_to_background?: number | null } | null;
  plate_layout: Record<string, WellRole> | null;
  ai_summary: string | null;
  data_analysis_report: string | null;
}

export function SharedExperiment() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<SharedPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    apiFetch(`/api/public/experiments/${token}`)
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setError(
            res.status === 404
              ? "This link is no longer active. The scientist who shared it may have revoked access."
              : "Something went wrong loading this experiment.",
          );
          return;
        }
        setData(await res.json());
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't reach the server. Check your connection and try again.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [token]);

  const plate = data?.plate_data;
  const isPlate = plate?._type === "plate96" && Array.isArray(plate.wells);

  return (
    <div className="min-h-[100dvh] bg-background">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-center gap-2">
            <Atom className="h-5 w-5 text-primary" />
            <span className="font-semibold">Bioalyzer</span>
          </div>
          <Badge variant="secondary">Shared · read-only</Badge>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-4 px-4 py-6">
        {loading && (
          <div className="space-y-3">
            <Skeleton className="h-8 w-2/3" />
            <Skeleton className="h-64 w-full" />
          </div>
        )}

        {error && !loading && (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
              <Link2Off className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">{error}</p>
            </CardContent>
          </Card>
        )}

        {data && !loading && (
          <>
            <div>
              <h1 className="text-2xl font-semibold">{data.name}</h1>
              <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted-foreground">
                <span>{data.date}</span>
                <span>{data.assay_type}</span>
                <span>{data.instrument}</span>
                <span className="capitalize">{data.status}</span>
              </p>
            </div>

            {data.notes && (
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm">Notes</CardTitle></CardHeader>
                <CardContent className="whitespace-pre-wrap text-sm text-muted-foreground">{data.notes}</CardContent>
              </Card>
            )}

            {isPlate && plate!.stats && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <FlaskConical className="h-4 w-4" /> Plate
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <PlateHeatmap
                    wells={plate!.wells!}
                    stats={plate!.stats!}
                    wavelength={plate!.metadata?.wavelength ?? null}
                    roles={data.plate_layout ?? undefined}
                  />
                  {(data.control_summary?.zprime != null || data.control_summary?.signal_to_background != null) && (
                    <div className="flex flex-wrap gap-4 border-t border-border pt-3 font-mono text-xs">
                      {data.control_summary?.zprime != null && (
                        <span>
                          <span className="text-muted-foreground">Z′ </span>
                          {data.control_summary.zprime.toFixed(2)}
                        </span>
                      )}
                      {data.control_summary?.signal_to_background != null && (
                        <span>
                          <span className="text-muted-foreground">S/B </span>
                          {data.control_summary.signal_to_background.toFixed(2)}
                        </span>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {data.ai_summary && (
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm">Analysis</CardTitle></CardHeader>
                <CardContent className="prose prose-sm dark:prose-invert max-w-none break-words">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{data.ai_summary}</ReactMarkdown>
                </CardContent>
              </Card>
            )}

            {data.data_analysis_report && (
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm">Full report</CardTitle></CardHeader>
                <CardContent className="prose prose-sm dark:prose-invert max-w-none break-words">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{data.data_analysis_report}</ReactMarkdown>
                </CardContent>
              </Card>
            )}

            <p className="pt-2 text-center text-xs text-muted-foreground">
              Shared read-only from Bioalyzer — plate-reader analysis for bench scientists.{" "}
              <a className="underline underline-offset-2 hover:text-foreground" href="/">Analyze your own plate</a>
            </p>
          </>
        )}
      </main>
    </div>
  );
}
