import { useState, type FormEvent } from "react";
import { DOSE_UNITS, type PlateLayout, type WellRole } from "@workspace/plate-analysis";
import { PlateHeatmap } from "@/components/PlateHeatmap";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/apiFetch";
import { Loader2 } from "lucide-react";
import type { ComponentProps } from "react";

const ROLE_LABELS: Record<WellRole, string> = {
  pos: "Untreated / vehicle",
  neg: "Kill control",
  blank: "Blank",
  sample: "Dose well",
};

const DEFAULT_SERIES: NonNullable<PlateLayout["series"]> = {
  axis: "columns", first: 1, last: 12, topAt: "first",
  topConcentration: null, unit: null, dilutionFactor: null,
};

export function ConfirmPlateLayout({
  id, updatedAt, saved, plate, onSave,
}: {
  id: number;
  updatedAt: string;
  saved: PlateLayout | null;
  plate: Pick<ComponentProps<typeof PlateHeatmap>, "wells" | "stats" | "wavelength">;
  onSave: () => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(!saved);
  const [roles, setRoles] = useState(saved?.roles ?? {});
  const [role, setRole] = useState<WellRole>("pos");
  const [series, setSeries] = useState(saved?.series ?? DEFAULT_SERIES);
  const [hasSeries, setHasSeries] = useState(saved ? Boolean(saved.series) : true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lastLane = series.axis === "columns" ? 12 : 8;

  const setLaneRole = (wells: string[]) => {
    setRoles((previous) => {
      const next = { ...previous };
      const clear = wells.every((well) => next[well] === role);
      for (const well of wells) {
        if (clear) delete next[well];
        else next[well] = role;
      }
      return next;
    });
  };

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await apiFetch(`/api/experiments/${id}/plate-layout`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updatedAt, layout: { roles, series: hasSeries ? series : null } }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        if (response.status === 409) await onSave();
        throw new Error(payload?.error ?? "Could not confirm the plate layout.");
      }
      await onSave();
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not confirm the plate layout.");
    } finally {
      setBusy(false);
    }
  }

  if (!editing) return <Button type="button" variant="outline" onClick={() => setEditing(true)}>Edit plate layout</Button>;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Confirm plate layout</CardTitle>
        <CardDescription>Mark the wells from your bench layout, then check the dose range and units.</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={confirm}>
          <fieldset disabled={busy} className="min-w-0 space-y-4">
            <div className="flex flex-wrap gap-2">
              {(Object.keys(ROLE_LABELS) as WellRole[]).map((value) => (
                <Button key={value} type="button" size="sm" variant={value === role ? "default" : "outline"} aria-pressed={value === role} onClick={() => setRole(value)}>
                  {ROLE_LABELS[value]}
                </Button>
              ))}
            </div>
            <p className="text-sm text-muted-foreground">Select a well, row, or column to apply the selected role. Select it again to clear the role.</p>
            <div className="overflow-x-auto">
              <PlateHeatmap
                {...plate}
                roles={roles}
                editMode={!busy}
                onAssignWell={(well) => setLaneRole([well])}
                onAssignRow={(row) => setLaneRole(plate.wells.filter((well) => well.row === row).map(({ well }) => well))}
                onAssignCol={(col) => setLaneRole(plate.wells.filter((well) => well.col === col).map(({ well }) => well))}
              />
            </div>
            <label className="flex items-center gap-2 text-sm font-medium">
              <input type="checkbox" checked={hasSeries} onChange={(event) => setHasSeries(event.target.checked)} />
              This plate has a serial dilution
            </label>
            {hasSeries && (
              <>
                <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4 [&_select]:h-9 [&_select]:w-full [&_select]:rounded-md [&_select]:border [&_select]:bg-background [&_select]:px-2">
                  <label className="space-y-1">Dose axis
                    <select value={series.axis} onChange={(event) => {
                      const axis = event.target.value as typeof series.axis;
                      const max = axis === "columns" ? 12 : 8;
                      setSeries({ ...series, axis, first: Math.min(series.first, max), last: Math.min(series.last, max) });
                    }}><option value="columns">Across columns</option><option value="rows">Down rows</option></select>
                  </label>
                  <label className="space-y-1">First {series.axis === "columns" ? "column" : "row"}
                    <Input required type="number" min={1} max={lastLane} value={series.first} onChange={(event) => setSeries({ ...series, first: event.target.valueAsNumber || 1 })} />
                  </label>
                  <label className="space-y-1">Last {series.axis === "columns" ? "column" : "row"}
                    <Input required type="number" min={series.first} max={lastLane} value={series.last} onChange={(event) => setSeries({ ...series, last: event.target.valueAsNumber || 1 })} />
                  </label>
                  <label className="space-y-1">Highest dose
                    <select value={series.topAt} onChange={(event) => setSeries({ ...series, topAt: event.target.value as typeof series.topAt })}>
                      <option value="first">At the first {series.axis === "columns" ? "column" : "row"}</option>
                      <option value="last">At the last {series.axis === "columns" ? "column" : "row"}</option>
                    </select>
                  </label>
                  <label className="space-y-1">Top concentration
                    <Input type="number" step="any" min={0} value={series.topConcentration ?? ""} onChange={(event) => setSeries({ ...series, topConcentration: event.target.valueAsNumber || null })} />
                  </label>
                  <label className="space-y-1">Concentration unit
                    <select value={series.unit ?? ""} onChange={(event) => setSeries({ ...series, unit: (event.target.value || null) as typeof series.unit })}>
                      <option value="">Select a unit</option>
                      {DOSE_UNITS.map((unit) => <option key={unit}>{unit}</option>)}
                    </select>
                  </label>
                  <label className="space-y-1">Dilution factor
                    <Input type="number" step="any" min={1} value={series.dilutionFactor ?? ""} onChange={(event) => setSeries({ ...series, dilutionFactor: event.target.valueAsNumber || null })} />
                  </label>
                </div>
                <p className="text-sm text-muted-foreground">Each row or column in the dose range is one concentration. Bioalyzer groups its measured wells as replicates and excludes vehicle, blank, and kill controls.</p>
              </>
            )}
          </fieldset>
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          <Button type="submit" disabled={busy}>{busy && <Loader2 className="animate-spin" />} Run analysis</Button>
        </form>
      </CardContent>
    </Card>
  );
}
