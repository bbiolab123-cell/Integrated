import { z } from "zod";

const NonDoseQuantifyChartSchema = z.object({
  type: z.enum(["column_means", "row_means", "well_scatter"]),
  title: z.string().min(1).max(120),
  dose_response_config: z.null().optional(),
});

const DoseResponseQuantifyChartSchema = z.object({
  type: z.literal("dose_response"),
  title: z.string().min(1).max(120),
  dose_response_config: z.object({
    orientation: z.enum(["row", "column"]),
    index: z.string().min(1).max(2),
    top_concentration: z.number().positive().finite(),
    unit: z.string().min(1).max(20).regex(/^[A-Za-zµμ/%]+$/),
    dilution_factor: z.number().gt(1).finite(),
    reverse: z.boolean(),
  }),
});

export const QuantifyResponseSchema = z.object({
  answer: z.string().min(1),
  chart: z.union([NonDoseQuantifyChartSchema, DoseResponseQuantifyChartSchema]).nullable(),
});

export type QuantifyChartSpec = z.infer<typeof QuantifyResponseSchema>["chart"];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizedScientificText(value: string): string {
  return value.toLowerCase().replace(/[µμ]/g, "u").replace(/\s+/g, " ");
}

export function doseResponseConfigIsGrounded(
  source: string,
  chart: Exclude<QuantifyChartSpec, null> & { type: "dose_response" },
): boolean {
  const normalized = normalizedScientificText(source);
  const config = chart.dose_response_config;
  const index = config.index.toUpperCase();
  const validIndex = config.orientation === "column"
    ? /^(?:[1-9]|1[0-2])$/.test(index)
    : /^[A-H]$/.test(index);
  if (!validIndex) return false;

  const orientationWord = config.orientation === "column" ? "(?:column|col)" : "row";
  const orientationIsPresent = new RegExp(`\\b${orientationWord}\\s*${escapeRegExp(index)}\\b`, "i").test(normalized);
  const concentration = String(config.top_concentration);
  const unit = normalizedScientificText(config.unit);
  const concentrationIsPresent = new RegExp(
    `(?:\\b${escapeRegExp(concentration)}\\s*${escapeRegExp(unit)}\\b|\\b${escapeRegExp(unit)}\\s*${escapeRegExp(concentration)}\\b)`,
    "i",
  ).test(normalized);
  const topIsExplicit = /\b(?:top|starting|initial|maximum|max)\s+(?:dose|concentration|conc)\b|\btop\s+conc\b/.test(normalized);
  const factor = escapeRegExp(String(config.dilution_factor));
  const dilutionIsPresent = new RegExp(
    `(?:\\b${factor}\\s*[- ]?fold\\b|\\b(?:dilution\\s+factor|factor)(?:\\s+of)?\\s*${factor}\\b|\\b1\\s*:\\s*${factor}\\b)`,
    "i",
  ).test(normalized);

  return orientationIsPresent && concentrationIsPresent && topIsExplicit && dilutionIsPresent;
}
