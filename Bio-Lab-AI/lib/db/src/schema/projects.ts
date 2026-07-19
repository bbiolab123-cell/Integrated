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
  // Optional AI synthesis across the project's experiments (Phase 2).
  ai_summary: text("ai_summary"),
  ai_summary_request_id: text("ai_summary_request_id"),
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
