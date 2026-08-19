// What a read-only share link is allowed to expose.
//
// This is the only place in the product where experiment data leaves the
// authenticated boundary, so the payload is built by an explicit allowlist
// rather than by deleting fields from the row. A denylist silently leaks every
// column added later; an allowlist silently omits it, which is the failure
// direction to prefer.

import type { Experiment } from "@workspace/db";

export interface PublicExperiment {
  name: string;
  date: string;
  assay_type: string;
  instrument: string;
  status: string;
  notes: string | null;
  protocol: unknown;
  plate_data: unknown;
  control_summary: unknown;
  plate_layout: unknown;
  ai_summary: string | null;
  data_analysis_report: string | null;
  shared: true;
}

function parseJson(value: string | null | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Fields deliberately withheld from a public link, and why:
 *
 * - `user_id` — identifies the account that owns the work.
 * - `file_name` — the scientist's local path/filename, treated as sensitive by
 *   the AI sanitizer for the same reason it is withheld here.
 * - `id`, `project_id`, `conversation_id` — internal identifiers that invite
 *   probing at other endpoints and reveal how much else exists.
 * - `share_token` — never echo the capability back inside the payload it grants.
 * - `*_request_id` — internal AI request identifiers.
 * - `created_at` / `updated_at` — editing timestamps are not the recipient's
 *   business; `date` is the experiment date the scientist chose to record.
 */
export function toPublicExperiment(experiment: Experiment): PublicExperiment {
  return {
    name: experiment.name,
    date: experiment.date,
    assay_type: experiment.assay_type,
    instrument: experiment.instrument,
    status: experiment.status,
    notes: experiment.notes ?? null,
    protocol: parseJson(experiment.protocol_json),
    plate_data: parseJson(experiment.raw_data_json),
    control_summary: parseJson(experiment.control_summary_json),
    plate_layout: parseJson(experiment.plate_layout_json),
    ai_summary: experiment.ai_summary ?? null,
    data_analysis_report: experiment.data_analysis_report ?? null,
    shared: true,
  };
}
