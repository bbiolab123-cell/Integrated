// Shared structured-protocol type + parser. Used by the protocol design/upload
// routes (experiments.ts and projects.ts) to produce it, and by the chat route
// (gemini.ts) to ground conversation once a protocol is finalized.

import { generateContentWithRetry } from "./aiRetry";

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

export function protocolToMarkdown(protocol: StructuredProtocol): string {
  const section = (title: string, items: string[]) => (items.length ? `### ${title}\n${items.map((i) => `- ${i}`).join("\n")}\n\n` : "");
  return [
    protocol.objective ? `**Objective:** ${protocol.objective}\n\n` : "",
    section("Materials", protocol.materials),
    section("Controls", protocol.controls),
    protocol.plate_layout ? `### Plate layout\n${protocol.plate_layout}\n\n` : "",
    protocol.steps.length ? `### Steps\n${protocol.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n\n` : "",
    protocol.expected_readout ? `### Expected readout\n${protocol.expected_readout}\n\n` : "",
    protocol.suggested_analysis ? `### Suggested analysis\n${protocol.suggested_analysis}\n\n` : "",
    section("AI review notes", protocol.review_notes),
  ].join("");
}

// Shared call: ask Gemini to produce/refine a structured protocol (with its own
// critique) and parse the result. Used by the experiment AI-design/.docx-upload
// paths and the project-level protocol path so downstream storage/rendering
// never needs to know the source.
export async function structureProtocolWithAI(systemInstruction: string, userPrompt: string): Promise<StructuredProtocol | null> {
  const response = await generateContentWithRetry({
    model: "gemini-2.5-flash",
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    config: {
      systemInstruction,
      maxOutputTokens: 8192,
      responseMimeType: "application/json",
      thinkingConfig: { thinkingBudget: 0 },
    },
  });
  return parseStructuredProtocol(response.text ?? "{}");
}
