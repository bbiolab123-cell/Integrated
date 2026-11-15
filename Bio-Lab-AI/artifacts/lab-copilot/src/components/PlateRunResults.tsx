import { formatPlateNumber, potencyAnswer, type PlateResults } from "@workspace/plate-analysis";
import { CartesianGrid, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function DoseResponseResult({ results, showHeadline = true }: { results: PlateResults | null; showHeadline?: boolean }) {
  const fit = results?.fit;
  if (!fit || !results) return <p className="text-sm text-muted-foreground">{potencyAnswer(results)}</p>;
  const [first, last] = [results.points[0].dose, results.points[results.points.length - 1].dose];

  return (
    <div className="space-y-3">
      {showHeadline && <p className="font-semibold">{potencyAnswer(results)}</p>}
      <p className="text-sm text-muted-foreground">The measured response {results.direction} as concentration increases.</p>
      <div className="h-64 min-w-0" aria-label="Dose-response chart">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 8, right: 22, bottom: 30, left: 18 }}>
            <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
            <XAxis type="number" dataKey="dose" name="Concentration" unit={` ${fit.unit}`} scale="log" domain={[first, last]} allowDataOverflow tickFormatter={formatPlateNumber} tick={{ fontSize: 11 }} label={{ value: `Concentration (${fit.unit})`, position: "bottom", offset: 8, fill: "currentColor" }} />
            <YAxis type="number" dataKey="response" name="Response" unit="%" tick={{ fontSize: 11 }} domain={["auto", "auto"]} label={{ value: "% of vehicle", angle: -90, position: "insideLeft", fill: "currentColor" }} />
            <Tooltip formatter={(value: number) => formatPlateNumber(value)} contentStyle={{ background: "hsl(var(--popover))", color: "hsl(var(--popover-foreground))", border: "1px solid hsl(var(--border))" }} />
            <Scatter name="4PL fit" data={fit.curve} line={{ stroke: "hsl(var(--primary))", strokeWidth: 2 }} shape={() => <></>} isAnimationActive={false} />
            <Scatter name="Dose group mean" data={results.points} fill="hsl(var(--primary))" isAnimationActive={false} />
          </ScatterChart>
        </ResponsiveContainer>
      </div>
      <details className="rounded-md border p-3 text-sm">
        <summary className="cursor-pointer font-medium">How potency was calculated</summary>
        <p className="mt-2">Response = 100 × (well − mean blank) / (mean vehicle − mean blank). The model fits the mean normalized response at each dose to a four-parameter logistic curve.</p>
        <p className="mt-2">R² {formatPlateNumber(fit.r2)} · Hill slope magnitude {formatPlateNumber(fit.hill)} · Low-dose plateau {formatPlateNumber(fit.top)}% · High-dose plateau {formatPlateNumber(fit.bottom)}%</p>
        <p className="mt-2">The approximate 95% confidence interval is calculated on the log concentration scale from fit residuals across dose groups.</p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead><tr><th scope="col">Concentration</th><th scope="col">Mean response</th><th scope="col">Replicate CV</th><th scope="col">Wells used</th></tr></thead>
            <tbody>{results.points.map(({ dose, response, wells, cvPercent }) => (
              <tr key={dose} className="border-t">
                <td className="py-1.5 pr-2">{formatPlateNumber(dose)} {fit.unit}</td>
                <td className="pr-2">{formatPlateNumber(response)}%</td>
                <td className="pr-2">{cvPercent === null ? "—" : `${formatPlateNumber(cvPercent)}%`}</td>
                <td>{wells.join(", ")}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

export function PlateRunResults({ results }: { results: PlateResults | null }) {
  const layout = results?.layout;
  const series = layout?.series;
  const qc = results?.qc;
  return (
    <Card>
      <CardHeader><CardTitle>Calculated plate results</CardTitle></CardHeader>
      <CardContent className="space-y-6">
        {layout && (
          <div className="rounded-md border bg-muted/40 p-3 text-sm">
            <p className="font-medium">{results.layoutSource === "sample" ? "Sample plate layout" : "Confirmed plate layout"}</p>
            <p>{series
              ? `Dose series: ${series.axis} ${series.first}–${series.last}. Highest dose at ${series.topAt === "first" ? series.first : series.last}.`
              : "No dose series selected."}</p>
            {series?.topConcentration && series.unit && series.dilutionFactor && (
              <p>Top concentration {formatPlateNumber(series.topConcentration)} {series.unit} · {formatPlateNumber(series.dilutionFactor)}× serial dilution</p>
            )}
            <p className="mt-1 text-muted-foreground">Vehicle: {qc?.vehicle.wells.join(", ") || "none"} · Blank: {qc?.blank.wells.join(", ") || "none"} · Kill control: {qc?.kill.wells.join(", ") || "none"}</p>
          </div>
        )}
        <DoseResponseResult results={results} />
        {qc && (
          <div className="space-y-2 border-t pt-4 text-sm">
            <h3 className="font-semibold">Quality checks</h3>
            <p>{qc.zPrime === null ? "Z′ needs replicate vehicle and kill controls with different means." : `Z′: ${formatPlateNumber(qc.zPrime)}`}</p>
            <p>Signal window (blank vs untreated): {qc.window === null ? "Needs measured blank and vehicle wells." : formatPlateNumber(qc.window)}</p>
            {qc.signalToBackground !== null && <p>Signal-to-background: {formatPlateNumber(qc.signalToBackground)}×</p>}
            <details>
              <summary className="cursor-pointer font-medium">How quality was calculated</summary>
              <p className="mt-2">Signal window = mean vehicle − mean blank. Signal-to-background = mean vehicle / mean blank.</p>
              <p className="mt-1">Z′ = 1 − 3 × (vehicle SD + kill-control SD) / |mean vehicle − mean kill control|. SD is the sample standard deviation.</p>
              <ul className="mt-2 space-y-1">
                {([["Vehicle", qc.vehicle], ["Blank", qc.blank], ["Kill control", qc.kill]] as const).map(([label, group]) => (
                  <li key={label}>{label} · n = {group.count} · mean {group.mean === null ? "—" : formatPlateNumber(group.mean)} · SD {group.sd === null ? "—" : formatPlateNumber(group.sd)}</li>
                ))}
              </ul>
            </details>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
