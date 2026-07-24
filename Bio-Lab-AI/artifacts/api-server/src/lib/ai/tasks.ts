export const AI_TASK_TYPES = [
  "experiment_analysis",
  "data_analysis",
  "experiment_chat",
  "experiment_comparison",
  "protocol_generation",
  "sop_structuring",
  "project_chat",
  "project_synthesis",
  "general_chat",
] as const;

export type AiTaskType = typeof AI_TASK_TYPES[number];

export const TRAINING_DATASET_SCHEMA_VERSION = 2;
