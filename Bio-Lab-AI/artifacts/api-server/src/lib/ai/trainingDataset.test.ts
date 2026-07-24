import assert from "node:assert/strict";
import test from "node:test";
import type { AiTrainingExample } from "@workspace/db";
import {
  buildTrainingDataset,
  splitForTrainingGroup,
  type TrainingPolicy,
  type TrainingSplit,
} from "./trainingDataset";
import { AI_TASK_TYPES, type AiTaskType } from "./tasks";

const testPolicy: TrainingPolicy = {
  minimumExamples: AI_TASK_TYPES.length,
  minimumPerTask: 1,
  minimumHoldoutExamples: 1,
  minimumHoldoutGroups: 1,
  hashSecret: "unit-test-secret-that-is-not-used-in-production",
};

function example(
  requestId: string,
  taskType: AiTaskType = "experiment_analysis",
  overrides: Partial<AiTrainingExample> = {},
): AiTrainingExample {
  const messages = [
    { role: "system", content: `<TASK=${taskType}>\nUse only supplied evidence.` },
    { role: "user", content: `Review scientific record ${requestId}.` },
  ];
  return {
    request_id: requestId,
    user_id: "user_secret_owner",
    task_type: taskType,
    input_json: JSON.stringify(messages),
    model_output: "Unreviewed model draft.",
    corrected_output: `Scientist-reviewed answer ${requestId}.`,
    rating: 5,
    approved_for_training: true,
    provenance: "human_corrected",
    schema_version: 2,
    experiment_id: null,
    project_id: null,
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function projectForSplit(split: TrainingSplit, start = 1): number {
  for (let id = start; id < start + 100_000; id += 1) {
    if (splitForTrainingGroup(`project:${id}`) === split) return id;
  }
  throw new Error(`Could not find a project for ${split}`);
}

test("training export is de-identified, deterministic, grouped, and auditable", () => {
  const projects = {
    train: projectForSplit("train"),
    validation: projectForSplit("validation"),
    test: projectForSplit("test"),
  };
  const rows = (["train", "validation", "test"] as const).flatMap((split) => (
    AI_TASK_TYPES.map((task, index) => example(`request-${split}-${index}`, task, {
      project_id: projects[split],
    }))
  ));

  const readinessPolicy = { ...testPolicy, minimumExamples: rows.length };
  const first = buildTrainingDataset(rows, readinessPolicy);
  const second = buildTrainingDataset([...rows].reverse(), readinessPolicy);

  assert.equal(first.status.ready_for_training, true);
  assert.equal(first.status.approved_examples, rows.length);
  assert.deepEqual(first.status.missing_tasks, []);
  assert.deepEqual(first.status.underrepresented_tasks, []);
  assert.deepEqual(first.status.missing_holdout_tasks, { validation: [], test: [] });
  assert.equal(first.status.split_counts.validation >= 1, true);
  assert.equal(first.status.split_counts.test >= 1, true);
  assert.equal(first.status.split_group_counts.validation, 1);
  assert.equal(first.status.split_group_counts.test, 1);
  assert.equal(first.status.dataset_sha256, second.status.dataset_sha256);
  assert.deepEqual(first.lines, second.lines);

  const serialized = first.lines.join("\n");
  assert.equal(serialized.includes("user_secret_owner"), false);
  assert.equal(serialized.includes("project_id"), false);
  assert.equal(serialized.includes("experiment_id"), false);
  assert.equal(serialized.includes("request-train-0"), true, "request text in this fixture is prompt content");
  assert.match(first.rows[0].group_hash, /^[a-f0-9]{64}$/);
  assert.match(first.rows[0].input_hash, /^[a-f0-9]{64}$/);
  assert.match(first.rows[0].example_hash, /^[a-f0-9]{64}$/);

  const sameProjectRows = first.rows.filter((row) => row.group_hash === first.rows[0].group_hash);
  assert.equal(new Set(sameProjectRows.map((row) => row.split)).size, 1);
});

test("malformed, unedited, and incorrectly tagged approvals are excluded", () => {
  const malformed = example("malformed", "data_analysis", { input_json: "not-json" });
  const unedited = example("unedited", "data_analysis", {
    model_output: "same",
    corrected_output: "same",
  });
  const wrongTag = example("wrong-tag", "data_analysis", {
    input_json: JSON.stringify([
      { role: "system", content: "<TASK=general_chat>\nWrong tag." },
      { role: "user", content: "Question." },
    ]),
  });
  const unknownTask = {
    ...example("unknown-task"),
    task_type: "not_a_real_task",
  } as AiTrainingExample;

  const dataset = buildTrainingDataset([malformed, unedited, wrongTag, unknownTask], testPolicy);
  assert.equal(dataset.rows.length, 0);
  assert.deepEqual(dataset.status.invalid_reason_counts, {
    malformed_input_json: 1,
    unedited_model_output: 1,
    task_tag_mismatch: 1,
    unknown_task: 1,
  });
  assert.equal(dataset.status.ready_for_training, false);
});

test("non-alternating conversations and obvious PII are quarantined", () => {
  const nonAlternating = example("bad-roles", "experiment_chat", {
    input_json: JSON.stringify([
      { role: "system", content: "<TASK=experiment_chat>\nHelp." },
      { role: "user", content: "First question." },
      { role: "user", content: "Second question." },
    ]),
  });
  const piiInput = example("pii-input", "experiment_chat", {
    input_json: JSON.stringify([
      { role: "system", content: "<TASK=experiment_chat>\nHelp." },
      { role: "user", content: "Email scientist@example.com." },
    ]),
  });
  const piiCorrection = example("pii-correction", "experiment_chat", {
    corrected_output: "Send the result to scientist@example.com.",
  });

  const dataset = buildTrainingDataset([nonAlternating, piiInput, piiCorrection], testPolicy);
  assert.equal(dataset.rows.length, 0);
  assert.deepEqual(dataset.status.invalid_reason_counts, {
    roles_not_alternating: 1,
    input_failed_privacy_scan: 1,
    correction_failed_privacy_scan: 1,
  });
});

test("exact duplicates are deduplicated and conflicting corrections are quarantined", () => {
  const duplicateA = example("duplicate-a", "project_chat", {
    input_json: JSON.stringify([
      { role: "system", content: "<TASK=project_chat>\nSummarize." },
      { role: "user", content: "Shared duplicate input." },
    ]),
    corrected_output: "One reviewed answer.",
  });
  const duplicateB = example("duplicate-b", "project_chat", {
    input_json: duplicateA.input_json,
    corrected_output: duplicateA.corrected_output,
  });
  const conflictA = example("conflict-a", "project_chat", {
    input_json: JSON.stringify([
      { role: "system", content: "<TASK=project_chat>\nSummarize." },
      { role: "user", content: "Conflicting input." },
    ]),
    corrected_output: "First reviewed answer.",
  });
  const conflictB = example("conflict-b", "project_chat", {
    input_json: conflictA.input_json,
    corrected_output: "Incompatible reviewed answer.",
  });

  const dataset = buildTrainingDataset([duplicateA, duplicateB, conflictA, conflictB], {
    ...testPolicy,
    minimumExamples: 1,
  });
  assert.equal(dataset.rows.length, 1);
  assert.equal(dataset.status.duplicate_examples, 1);
  assert.equal(dataset.status.conflicting_inputs, 1);
  assert.equal(dataset.status.invalid_reason_counts.duplicate_example, 1);
  assert.equal(dataset.status.invalid_reason_counts.conflicting_input, 2);
  assert.equal(dataset.status.excluded_examples, 3);
});

test("readiness fails when task, holdout size, or holdout group coverage is weak", () => {
  const validationProject = projectForSplit("validation");
  const testProject = projectForSplit("test");
  const rows = [
    example("train-only", "experiment_analysis", { project_id: projectForSplit("train") }),
    example("validation-only", "data_analysis", { project_id: validationProject }),
    example("test-only", "general_chat", { project_id: testProject }),
  ];
  const dataset = buildTrainingDataset(rows, {
    ...testPolicy,
    minimumExamples: 3,
    minimumPerTask: 2,
    minimumHoldoutExamples: 2,
    minimumHoldoutGroups: 2,
  });

  assert.equal(dataset.status.ready_for_training, false);
  assert.equal(dataset.status.underrepresented_tasks.length, AI_TASK_TYPES.length);
  assert.deepEqual(dataset.status.undersized_holdout_splits, ["validation", "test"]);
  assert.deepEqual(dataset.status.undergrouped_holdout_splits, ["validation", "test"]);
});
