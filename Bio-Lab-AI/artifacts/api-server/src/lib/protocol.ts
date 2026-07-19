// Shared structured-protocol type + parser. Used by the protocol design/upload
// routes (experiments.ts) to produce it, and by the provider-neutral chat route to
// ground conversation once a protocol is finalized.

export interface StructuredProtocol {
  objective: string;
  materials: string[];
  controls: string[];
  plate_layout: string;
  steps: string[];
  expected_readout: string;
  suggested_analysis: string;
  // The AI's own critique of the protocol it just produced/refined — gaps,
  // ambiguities, missing controls. Surfaced to the user as suggestions, not
  // silently applied, so the scientist stays in control of the final SOP.
  review_notes: string[];
  // Populated only when refining an existing protocol — a plain-language list of
  // what actually changed vs. the previous version, so the scientist can tell
  // whether their refinement note took effect instead of re-reading the whole
  // protocol to spot the diff themselves. Empty on first generation.
  changes_summary: string[];
}

export const PROTOCOL_JSON_FORMAT = `{
  "objective": "one or two sentences stating what this experiment tests",
  "materials": ["reagent/equipment with key spec (concentration, catalog detail if known)", "..."],
  "controls": ["control and its purpose (positive, negative, vehicle, blank)", "..."],
  "plate_layout": "how samples/doses/controls are arranged on the plate",
  "steps": ["numbered, actionable step with concentrations/volumes/timings", "..."],
  "expected_readout": "what is measured and how it is interpreted",
  "suggested_analysis": "the quantification method to apply (e.g. 4PL IC50, Z'-factor, standard curve)",
  "review_notes": ["a specific gap, ambiguity, or missing control in THIS protocol — be a critical reviewer, not a cheerleader", "..."],
  "changes_summary": ["ONLY if refining an existing protocol: a specific, concrete change you just made, e.g. 'Increased replicate count from 2 to 3 per dose' — omit or leave empty if this is the first draft"]
}`;

// Keep only genuine strings — the AI occasionally nests an object where a plain
// string was asked for; String()-coercing that would silently render "[object
// Object]" in the UI and in future prompts, so drop non-string entries instead.
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function parseStructuredProtocol(text: string): StructuredProtocol | null {
  try {
    const parsed = JSON.parse(text) as Partial<StructuredProtocol>;
    return {
      objective: typeof parsed.objective === "string" ? parsed.objective : "",
      materials: stringArray(parsed.materials),
      controls: stringArray(parsed.controls),
      plate_layout: typeof parsed.plate_layout === "string" ? parsed.plate_layout : "",
      steps: stringArray(parsed.steps),
      expected_readout: typeof parsed.expected_readout === "string" ? parsed.expected_readout : "",
      suggested_analysis: typeof parsed.suggested_analysis === "string" ? parsed.suggested_analysis : "",
      review_notes: stringArray(parsed.review_notes),
      changes_summary: stringArray(parsed.changes_summary),
    };
  } catch {
    return null;
  }
}
