import { Link } from "wouter";
import { calculatePlateResults, parseDelimitedRows, parsePlateRows, SAMPLE_LAYOUT } from "@workspace/plate-analysis";
import { PlateRunResults } from "@/components/PlateRunResults";
import { PlateHeatmap } from "@/components/PlateHeatmap";
import sampleCsv from "../../../../examples/demo-dose-response-plate.csv?raw";

const sample = parsePlateRows(parseDelimitedRows(sampleCsv, "sample.csv"), "sample.csv");
const results = sample && calculatePlateResults(sample.wells, SAMPLE_LAYOUT, "sample");

export function SamplePlate() {
  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 px-4 py-8 sm:px-6">
      <nav className="flex items-center justify-between gap-3 text-sm">
        <Link href="/" className="font-semibold text-primary">Bioalyzer</Link>
        <Link href="/sign-up" className="rounded-md border px-3 py-2 font-medium hover:bg-muted">Sign up to save runs</Link>
      </nav>
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Compound-X sample plate</h1>
        <p className="mt-2 text-sm text-muted-foreground">An example MTT viability run with a known layout. The same calculator runs on uploaded plates.</p>
      </header>
      {sample && results ? (
        <>
          <PlateRunResults results={results} />
          <section className="space-y-3 rounded-xl border bg-card p-4">
            <h2 className="text-lg font-semibold">Plate heatmap</h2>
            <div className="overflow-x-auto">
              <PlateHeatmap wells={sample.wells} stats={sample.stats} roles={SAMPLE_LAYOUT.roles} wavelength={sample.metadata.wavelength} />
            </div>
          </section>
        </>
      ) : <p role="alert">The sample plate could not be loaded.</p>}
    </main>
  );
}
