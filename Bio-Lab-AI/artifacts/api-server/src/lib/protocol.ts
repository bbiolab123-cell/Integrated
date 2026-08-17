// Shared structured-protocol type + parser. Used by the protocol design/upload
// routes (experiments.ts and projects.ts) to produce it, and by the
// provider-neutral chat route to ground conversation once a protocol is
// finalized.

import { z } from "zod";
// Import directly from the specific submodules (not the "./ai" barrel) — that
// barrel re-exports ./ai/context, which itself imports parseStructuredProtocol
// from this file; going through it here would create a circular import.
import { generateAiJson, type AiCallContext } from "./ai/service";
import { numericAuditNotice } from "./ai/numericAudit";
import { logger } from "./logger";

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
  } catch (err) {
    logger.warn(
      { err, field: "protocol_json", contentLength: text.length, fallback: "treat_protocol_as_unstructured_or_absent", retryExpected: false },
      "Stored protocol JSON could not be parsed into the structured protocol format, so the caller will use unstructured data or treat the protocol as absent. Inspect the affected request and repair the stored protocol before relying on protocol-aware features.",
    );
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

const StructuredProtocolSchema = z.object({
  objective: z.string(),
  materials: z.array(z.string()),
  controls: z.array(z.string()),
  plate_layout: z.string(),
  steps: z.array(z.string()),
  expected_readout: z.string(),
  suggested_analysis: z.string(),
  review_notes: z.array(z.string()),
  changes_summary: z.array(z.string()),
});

// Shared call: ask the configured provider to produce/refine a structured
// protocol (with its own critique) and parse the result. Used by both the
// experiment AI-design/.docx-upload paths and the project-level protocol
// path so downstream storage/rendering never needs to know the source.
export async function structureProtocolWithAI(
  systemInstruction: string,
  userPrompt: string,
  context: AiCallContext,
): Promise<{ protocol: StructuredProtocol; requestId: string }> {
  const response = await generateAiJson({
    ...context,
    systemInstruction,
    messages: [{ role: "user", content: userPrompt }],
    maxTokens: 4096,
  }, StructuredProtocolSchema);
  if (context.taskType === "sop_structuring") {
    const auditNotice = numericAuditNotice(JSON.stringify(response.data), `${systemInstruction}\n${userPrompt}`);
    if (auditNotice) {
      logger.warn(
        {
          aiRequestId: response.requestId,
          taskType: context.taskType,
          userId: context.userId,
          experimentId: context.experimentId,
          projectId: context.projectId,
          validationFailure: "ungrounded_numeric_claim",
          responseAnnotated: true,
          retryExpected: false,
        },
        "The AI-structured SOP introduced numeric claims that could not be traced to the uploaded document; the protocol was preserved with a human-review note. Verify the flagged values against the source SOP before use and investigate model quality if this recurs.",
      );
      response.data.review_notes.push(auditNotice);
    }
  }
  return { protocol: response.data, requestId: response.requestId };
}
