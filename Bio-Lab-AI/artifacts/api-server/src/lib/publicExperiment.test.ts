import test from "node:test";
import assert from "node:assert/strict";

import { toPublicExperiment } from "./publicExperiment";
import type { Experiment } from "@workspace/db";

function experiment(overrides: Partial<Experiment> = {}): Experiment {
  return {
    id: 7,
    user_id: "user_2abcPRIVATE",
    name: "Compound-X cytotoxicity",
    date: "2026-08-16",
    assay_type: "Viability",
    instrument: "Synergy H1",
    notes: "MTT, 24h exposure",
    status: "success",
    protocol_json: JSON.stringify({ objective: "IC50" }),
    file_name: "C:/Users/rup/private/plate-run-3.xlsx",
    raw_data_json: JSON.stringify({ _type: "plate96", wells: [] }),
    control_summary_json: JSON.stringify({ zprime: 0.82 }),
    plate_layout_json: JSON.stringify({ A1: "pos" }),
    share_token: "f".repeat(64),
    ai_summary: "The plate is clean.",
    ai_summary_request_id: "req-private-1",
    ai_next_experiments_json: null,
    data_analysis_report: "# Report",
    data_analysis_request_id: "req-private-2",
    protocol_ai_request_id: "req-private-3",
    conversation_id: 42,
    project_id: 9,
    created_at: new Date("2026-08-01T00:00:00Z"),
    updated_at: new Date("2026-08-16T00:00:00Z"),
    ...overrides,
  } as Experiment;
}

test("the shared payload carries the science the scientist meant to share", () => {
  const shared = toPublicExperiment(experiment());

  assert.equal(shared.name, "Compound-X cytotoxicity");
  assert.equal(shared.assay_type, "Viability");
  assert.equal(shared.instrument, "Synergy H1");
  assert.equal(shared.notes, "MTT, 24h exposure");
  assert.deepEqual(shared.control_summary, { zprime: 0.82 });
  assert.deepEqual(shared.plate_layout, { A1: "pos" });
  assert.equal(shared.ai_summary, "The plate is clean.");
  assert.equal(shared.data_analysis_report, "# Report");
  assert.equal(shared.shared, true);
});

test("no identifier, filename, or internal id survives into a public link", () => {
  const serialized = JSON.stringify(toPublicExperiment(experiment()));

  // The account behind the work.
  assert.equal(serialized.includes("user_2abcPRIVATE"), false);
  // The scientist's local path — sensitive for the same reason the AI
  // sanitizer strips filenames.
  assert.equal(serialized.includes("plate-run-3.xlsx"), false);
  assert.equal(serialized.includes("private"), false);
  // Internal AI request identifiers.
  assert.equal(serialized.includes("req-private-1"), false);
  assert.equal(serialized.includes("req-private-2"), false);
  assert.equal(serialized.includes("req-private-3"), false);
  // Never echo the capability back inside the payload it unlocks.
  assert.equal(serialized.includes("f".repeat(64)), false);
});

test("the payload is an allowlist, so a newly added column cannot leak by default", () => {
  // Simulates someone adding a sensitive column later and forgetting this file.
  const withNewColumn = experiment() as Experiment & { billing_email?: string };
  withNewColumn.billing_email = "rup@example.com";

  const serialized = JSON.stringify(toPublicExperiment(withNewColumn));
  assert.equal(serialized.includes("rup@example.com"), false);

  // And the shape stays exactly what we declared.
  assert.deepEqual(Object.keys(toPublicExperiment(experiment())).sort(), [
    "ai_summary",
    "assay_type",
    "control_summary",
    "data_analysis_report",
    "date",
    "instrument",
    "name",
    "notes",
    "plate_data",
    "plate_layout",
    "protocol",
    "shared",
    "status",
  ]);
});

test("internal ids are absent even though the row carries them", () => {
  const shared = toPublicExperiment(experiment()) as unknown as Record<string, unknown>;

  for (const key of ["id", "user_id", "file_name", "share_token", "project_id", "conversation_id", "created_at", "updated_at"]) {
    assert.equal(key in shared, false, `${key} must not be exposed`);
  }
});

test("malformed stored JSON degrades to null instead of throwing", () => {
  const shared = toPublicExperiment(experiment({
    protocol_json: "{not json",
    raw_data_json: "",
    control_summary_json: null,
  }));

  assert.equal(shared.protocol, null);
  assert.equal(shared.plate_data, null);
  assert.equal(shared.control_summary, null);
});
