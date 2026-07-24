import { boolean, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { experiments } from "./experiments";
import { projects } from "./projects";

export const aiTrainingExamples = pgTable("ai_training_examples", {
  request_id: text("request_id").primaryKey(),
  user_id: text("user_id").notNull(),
  task_type: text("task_type").notNull(),
  input_json: text("input_json").notNull(),
  model_output: text("model_output").notNull(),
  corrected_output: text("corrected_output"),
  rating: integer("rating"),
  approved_for_training: boolean("approved_for_training").notNull().default(false),
  provenance: text("provenance").notNull().default("model_draft"),
  schema_version: integer("schema_version").notNull().default(1),
  experiment_id: integer("experiment_id").references(() => experiments.id, { onDelete: "set null" }),
  project_id: integer("project_id").references(() => projects.id, { onDelete: "set null" }),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type AiTrainingExample = typeof aiTrainingExamples.$inferSelect;
