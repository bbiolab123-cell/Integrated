import { pgTable, serial, text, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

import { conversations } from "./conversations";

export const projects = pgTable("projects", {
  id: serial("id").primaryKey(),
  user_id: text("user_id").notNull(),
  name: text("name").notNull(),
  // The researcher's free-text brief: aims, background, hypotheses, what they've
  // tried. This is the "upload everything about the project" field the AI grounds on.
  goal: text("goal"),
  status: text("status").notNull().default("active"),
  // One overarching protocol for the whole project (aims, phases, which
  // experiments test what) — distinct from each experiment's own SOP.
  // Same StructuredProtocol JSON shape as experiments.protocol_json.
  protocol_json: text("protocol_json"),
  // Optional AI synthesis across the project's experiments (Phase 2).
  ai_summary: text("ai_summary"),
  // Set whenever ai_summary is (re)computed by this app's own AI pipeline —
  // distinguishes an owned synthesis from any future imported/legacy value.
  ai_summary_generated_at: timestamp("ai_summary_generated_at", { withTimezone: true }),
  // Project-level copilot thread (Phase 2). Mirrors experiments.conversation_id.
  conversation_id: integer("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const insertProjectSchema = createInsertSchema(projects).omit({
  id: true,
  created_at: true,
  updated_at: true,
});

export type Project = typeof projects.$inferSelect;
export type InsertProject = z.infer<typeof insertProjectSchema>;
