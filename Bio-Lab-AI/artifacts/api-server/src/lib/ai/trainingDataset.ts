import { createHash, createHmac } from "node:crypto";
import { z } from "zod";
import type { AiTrainingExample } from "@workspace/db";
import {
  AI_TASK_TYPES,
  TRAINING_DATASET_SCHEMA_VERSION,
  type AiTaskType,
} from "./tasks";
import { sanitizeAiText } from "./sanitize";

export const DEFAULT_MINIMUM_TRAINING_EXAMPLES = 200;
export const DEFAULT_MINIMUM_EXAMPLES_PER_TASK = 10;
export const DEFAULT_MINIMUM_HOLDOUT_EXAMPLES = 10;
export const DEFAULT_MINIMUM_HOLDOUT_GROUPS = 2;

const TrainingMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().trim().min(1).max(100_000),
}).strict();

const TrainingMessagesSchema = z.array(TrainingMessageSchema).min(2).max(200);
const taskTypeSet = new Set<string>(AI_TASK_TYPES);

export type TrainingSplit = "train" | "validation" | "test";
export type TrainingMessage = z.infer<typeof TrainingMessageSchema>;

export type TrainingExportRow = {
  dataset_schema_version: typeof TRAINING_DATASET_SCHEMA_VERSION;
  source_schema_version: number;
  task_type: AiTaskType;
  split: TrainingSplit;
  provenance: "human_corrected";
  group_hash: string;
  input_hash: string;
  example_hash: string;
  messages: TrainingMessage[];
};

export type TrainingPolicy = {
  minimumExamples: number;
  minimumPerTask: number;
  minimumHoldoutExamples: number;
  minimumHoldoutGroups: number;
  hashSecret: string;
};

export type TrainingDatasetStatus = {
  dataset_schema_version: typeof TRAINING_DATASET_SCHEMA_VERSION;
  total_generations: number;
  approved_submissions: number;
  approved_examples: number;
  excluded_examples: number;
  minimum_examples: number;
  minimum_examples_per_task: number;
  minimum_holdout_examples: number;
  minimum_holdout_groups: number;
  coverage: Record<AiTaskType, number>;
  missing_tasks: AiTaskType[];
  underrepresented_tasks: AiTaskType[];
  holdout_task_coverage: Record<"validation" | "test", Record<AiTaskType, number>>;
  missing_holdout_tasks: Record<"validation" | "test", AiTaskType[]>;
  split_counts: Record<TrainingSplit, number>;
  split_group_counts: Record<TrainingSplit, number>;
  missing_splits: TrainingSplit[];
  undersized_holdout_splits: TrainingSplit[];
  undergrouped_holdout_splits: TrainingSplit[];
  invalid_reason_counts: Record<string, number>;
  duplicate_examples: number;
  conflicting_inputs: number;
  dataset_sha256: string;
  ready_for_training: boolean;
};

export type TrainingDatasetBuild = {
  rows: TrainingExportRow[];
  lines: string[];
  status: TrainingDatasetStatus;
};

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function trainingPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): TrainingPolicy {
  const hashSecret = env.AI_TRAINING_HASH_SECRET?.trim()
    || env.CLERK_SECRET_KEY?.trim()
    || "local-development-only-training-hash-secret";
  return {
    minimumExamples: positiveInteger(env.AI_TRAINING_MIN_EXAMPLES, DEFAULT_MINIMUM_TRAINING_EXAMPLES),
    minimumPerTask: positiveInteger(env.AI_TRAINING_MIN_PER_TASK, DEFAULT_MINIMUM_EXAMPLES_PER_TASK),
    minimumHoldoutExamples: positiveInteger(
      env.AI_TRAINING_MIN_HOLDOUT_EXAMPLES,
      DEFAULT_MINIMUM_HOLDOUT_EXAMPLES,
    ),
    minimumHoldoutGroups: positiveInteger(
      env.AI_TRAINING_MIN_HOLDOUT_GROUPS,
      DEFAULT_MINIMUM_HOLDOUT_GROUPS,
    ),
    hashSecret,
  };
}

function sourceGroup(example: AiTrainingExample): string {
  if (example.project_id != null) return `project:${example.project_id}`;
  if (example.experiment_id != null) return `experiment:${example.experiment_id}`;
  return `request:${example.request_id}`;
}

export function splitForTrainingGroup(group: string): TrainingSplit {
  const bucket = Number.parseInt(
    createHash("sha256").update(`biolab-training-split-v1:${group}`).digest("hex").slice(0, 8),
    16,
  ) % 10;
  if (bucket === 0) return "test";
  if (bucket === 1) return "validation";
  return "train";
}

function opaqueHash(secret: string, namespace: string, value: string): string {
  return createHmac("sha256", secret).update(`${namespace}:${value}`).digest("hex");
}

function canonicalMessages(messages: TrainingMessage[]): string {
  return JSON.stringify(messages.map(({ role, content }) => ({ role, content: content.trim() })));
}

function invalidReason(example: AiTrainingExample): string | null {
  if (!example.approved_for_training) return "not_approved";
  if (!example.corrected_output?.trim()) return "missing_correction";
  if (example.provenance !== "human_corrected") return "invalid_provenance";
  if (example.corrected_output.trim() === example.model_output.trim()) return "unedited_model_output";
  if (!taskTypeSet.has(example.task_type)) return "unknown_task";

  let parsedInput: unknown;
  try {
    parsedInput = JSON.parse(example.input_json);
  } catch {
    return "malformed_input_json";
  }
  const parsedMessages = TrainingMessagesSchema.safeParse(parsedInput);
  if (!parsedMessages.success) return "invalid_messages";
  const messages = parsedMessages.data;
  if (messages.some((message) => sanitizeAiText(message.content) !== message.content)) {
    return "input_failed_privacy_scan";
  }
  if (sanitizeAiText(example.corrected_output) !== example.corrected_output) {
    return "correction_failed_privacy_scan";
  }
  if (messages[0]?.role !== "system") return "missing_system_message";
  if (messages.slice(1).some((message) => message.role === "system")) return "multiple_system_messages";
  if (!messages.some((message) => message.role === "user")) return "missing_user_message";
  if (messages.at(-1)?.role !== "user") return "input_does_not_end_with_user";
  if (messages.slice(1).some((message, index) => message.role !== (index % 2 === 0 ? "user" : "assistant"))) {
    return "roles_not_alternating";
  }
  if (!messages[0].content.includes(`<TASK=${example.task_type}>`)) return "task_tag_mismatch";
  return null;
}

function parseMessages(example: AiTrainingExample): TrainingMessage[] {
  return TrainingMessagesSchema.parse(JSON.parse(example.input_json));
}

function increment(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

export function buildTrainingDataset(
  sourceRows: AiTrainingExample[],
  policy: TrainingPolicy = trainingPolicyFromEnv(),
): TrainingDatasetBuild {
  const approvedSubmissions = sourceRows.filter((row) => row.approved_for_training).length;
  const invalidReasonCounts: Record<string, number> = {};
  const candidates: Array<TrainingExportRow & { correctedHash: string }> = [];

  for (const source of sourceRows) {
    if (!source.approved_for_training) continue;
    const reason = invalidReason(source);
    if (reason) {
      increment(invalidReasonCounts, reason);
      continue;
    }

    const taskType = source.task_type as AiTaskType;
    const inputMessages = parseMessages(source);
    const correctedOutput = source.corrected_output!.trim();
    const messages = [
      ...inputMessages.map((message) => ({ ...message, content: message.content.trim() })),
      { role: "assistant" as const, content: correctedOutput },
    ];
    const group = sourceGroup(source);
    const canonicalInput = `${taskType}\n${canonicalMessages(inputMessages)}`;
    const canonicalExample = `${canonicalInput}\n${correctedOutput}`;
    candidates.push({
      dataset_schema_version: TRAINING_DATASET_SCHEMA_VERSION,
      source_schema_version: source.schema_version,
      task_type: taskType,
      split: splitForTrainingGroup(group),
      provenance: "human_corrected",
      group_hash: opaqueHash(policy.hashSecret, "group", group),
      input_hash: opaqueHash(policy.hashSecret, "input", canonicalInput),
      example_hash: opaqueHash(policy.hashSecret, "example", canonicalExample),
      correctedHash: opaqueHash(policy.hashSecret, "corrected", correctedOutput),
      messages,
    });
  }

  const outputsByInput = new Map<string, Set<string>>();
  for (const row of candidates) {
    const outputs = outputsByInput.get(row.input_hash) ?? new Set<string>();
    outputs.add(row.correctedHash);
    outputsByInput.set(row.input_hash, outputs);
  }
  const conflictingInputHashes = new Set(
    [...outputsByInput.entries()]
      .filter(([, outputs]) => outputs.size > 1)
      .map(([inputHash]) => inputHash),
  );

  const seenExamples = new Set<string>();
  let duplicateExamples = 0;
  const exportRows: TrainingExportRow[] = [];
  for (const candidate of candidates) {
    if (conflictingInputHashes.has(candidate.input_hash)) continue;
    if (seenExamples.has(candidate.example_hash)) {
      duplicateExamples += 1;
      continue;
    }
    seenExamples.add(candidate.example_hash);
    const { correctedHash: _correctedHash, ...exportRow } = candidate;
    exportRows.push(exportRow);
  }

  exportRows.sort((a, b) => a.example_hash.localeCompare(b.example_hash));
  const lines = exportRows.map((row) => JSON.stringify(row));
  const coverage = Object.fromEntries(AI_TASK_TYPES.map((task) => [task, 0])) as Record<AiTaskType, number>;
  const splitCounts: Record<TrainingSplit, number> = { train: 0, validation: 0, test: 0 };
  const holdoutTaskCoverage = {
    validation: Object.fromEntries(AI_TASK_TYPES.map((task) => [task, 0])) as Record<AiTaskType, number>,
    test: Object.fromEntries(AI_TASK_TYPES.map((task) => [task, 0])) as Record<AiTaskType, number>,
  };
  const splitGroups: Record<TrainingSplit, Set<string>> = {
    train: new Set<string>(),
    validation: new Set<string>(),
    test: new Set<string>(),
  };
  for (const row of exportRows) {
    coverage[row.task_type] += 1;
    splitCounts[row.split] += 1;
    splitGroups[row.split].add(row.group_hash);
    if (row.split !== "train") holdoutTaskCoverage[row.split][row.task_type] += 1;
  }
  const splitGroupCounts: Record<TrainingSplit, number> = {
    train: splitGroups.train.size,
    validation: splitGroups.validation.size,
    test: splitGroups.test.size,
  };
  const missingTasks = AI_TASK_TYPES.filter((task) => coverage[task] === 0);
  const underrepresentedTasks = AI_TASK_TYPES.filter((task) => coverage[task] < policy.minimumPerTask);
  const missingHoldoutTasks = {
    validation: AI_TASK_TYPES.filter((task) => holdoutTaskCoverage.validation[task] === 0),
    test: AI_TASK_TYPES.filter((task) => holdoutTaskCoverage.test[task] === 0),
  };
  const allSplits: TrainingSplit[] = ["train", "validation", "test"];
  const holdoutSplits: TrainingSplit[] = ["validation", "test"];
  const missingSplits = allSplits.filter((split) => splitCounts[split] === 0);
  const undersizedHoldoutSplits = holdoutSplits.filter(
    (split) => splitCounts[split] < policy.minimumHoldoutExamples,
  );
  const undergroupedHoldoutSplits = holdoutSplits.filter(
    (split) => splitGroupCounts[split] < policy.minimumHoldoutGroups,
  );
  const conflictingInputs = conflictingInputHashes.size;
  if (duplicateExamples) invalidReasonCounts.duplicate_example = duplicateExamples;
  if (conflictingInputs) {
    invalidReasonCounts.conflicting_input = candidates.filter(
      (row) => conflictingInputHashes.has(row.input_hash),
    ).length;
  }
  const excludedExamples = approvedSubmissions - exportRows.length;
  const datasetSha256 = createHash("sha256")
    .update(lines.length ? `${lines.join("\n")}\n` : "")
    .digest("hex");
  const readyForTraining = exportRows.length >= policy.minimumExamples
    && underrepresentedTasks.length === 0
    && missingSplits.length === 0
    && undersizedHoldoutSplits.length === 0
    && undergroupedHoldoutSplits.length === 0
    && missingHoldoutTasks.validation.length === 0
    && missingHoldoutTasks.test.length === 0;

  return {
    rows: exportRows,
    lines,
    status: {
      dataset_schema_version: TRAINING_DATASET_SCHEMA_VERSION,
      total_generations: sourceRows.length,
      approved_submissions: approvedSubmissions,
      approved_examples: exportRows.length,
      excluded_examples: excludedExamples,
      minimum_examples: policy.minimumExamples,
      minimum_examples_per_task: policy.minimumPerTask,
      minimum_holdout_examples: policy.minimumHoldoutExamples,
      minimum_holdout_groups: policy.minimumHoldoutGroups,
      coverage,
      missing_tasks: missingTasks,
      underrepresented_tasks: underrepresentedTasks,
      holdout_task_coverage: holdoutTaskCoverage,
      missing_holdout_tasks: missingHoldoutTasks,
      split_counts: splitCounts,
      split_group_counts: splitGroupCounts,
      missing_splits: missingSplits,
      undersized_holdout_splits: undersizedHoldoutSplits,
      undergrouped_holdout_splits: undergroupedHoldoutSplits,
      invalid_reason_counts: invalidReasonCounts,
      duplicate_examples: duplicateExamples,
      conflicting_inputs: conflictingInputs,
      dataset_sha256: datasetSha256,
      ready_for_training: readyForTraining,
    },
  };
}
