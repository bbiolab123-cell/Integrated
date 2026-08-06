import { date, integer, pgTable, timestamp } from "drizzle-orm/pg-core";

/**
 * One global row per UTC day. The API consumes this counter atomically before
 * contacting Workers AI so restarts or multiple server instances cannot reset
 * the free-first allowance.
 */
export const aiDailyUsage = pgTable("ai_daily_usage", {
  usage_day: date("usage_day").primaryKey(),
  request_count: integer("request_count").notNull().default(0),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type AiDailyUsage = typeof aiDailyUsage.$inferSelect;
