import { pool } from "@workspace/db";

/**
 * Additive schema reconciliation, run at startup.
 *
 * Named for the AI training tables it originally covered, it is now the place
 * every additive column belongs. The hosting setup starts the bundled API
 * directly with no separate migration step, so a column added here reaches
 * production on deploy — whereas a column added only to the Drizzle schema
 * needs someone to remember a hand-written SQL statement. Forgetting that took
 * the API down once already: Drizzle selects every column it knows about, so a
 * column missing from the database fails *every* experiment query, not just
 * the feature that introduced it.
 *
 * Every statement is additive and idempotent. This lets old production
 * databases upgrade safely while fresh databases still use the Drizzle schema
 * as their source of truth. Destructive changes do NOT belong here.
 */
export async function ensureAiTrainingSchema(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      ALTER TABLE experiments
        ADD COLUMN IF NOT EXISTS control_summary_json text,
        ADD COLUMN IF NOT EXISTS ai_summary_request_id text,
        ADD COLUMN IF NOT EXISTS data_analysis_request_id text,
        ADD COLUMN IF NOT EXISTS protocol_ai_request_id text,
        ADD COLUMN IF NOT EXISTS plate_layout_json text,
        ADD COLUMN IF NOT EXISTS share_token text
    `);
    // A shared experiment is found by this token alone, so it has to be unique.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS experiments_share_token_idx
        ON experiments (share_token)
        WHERE share_token IS NOT NULL
    `);
    await client.query(`
      ALTER TABLE projects
        ADD COLUMN IF NOT EXISTS ai_summary_request_id text
    `);
    await client.query(`
      ALTER TABLE messages
        ADD COLUMN IF NOT EXISTS ai_request_id text
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_training_examples (
        request_id text PRIMARY KEY,
        user_id text NOT NULL,
        task_type text NOT NULL,
        input_json text NOT NULL,
        model_output text NOT NULL,
        corrected_output text,
        rating integer,
        approved_for_training boolean NOT NULL DEFAULT false,
        provenance text NOT NULL DEFAULT 'model_draft',
        schema_version integer NOT NULL DEFAULT 2,
        experiment_id integer REFERENCES experiments(id) ON DELETE SET NULL,
        project_id integer REFERENCES projects(id) ON DELETE SET NULL,
        created_at timestamp with time zone NOT NULL DEFAULT now(),
        updated_at timestamp with time zone NOT NULL DEFAULT now(),
        CONSTRAINT ai_training_examples_rating_check
          CHECK (rating IS NULL OR rating BETWEEN 1 AND 5)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS ai_training_examples_user_created_idx
        ON ai_training_examples (user_id, created_at)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS ai_training_examples_approved_idx
        ON ai_training_examples (approved_for_training, created_at)
        WHERE approved_for_training = true
    `);
    await client.query(`
      ALTER TABLE ai_training_examples
        ALTER COLUMN schema_version SET DEFAULT 2
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS error_events (
        id serial PRIMARY KEY,
        occurred_at timestamp with time zone NOT NULL DEFAULT now(),
        method text NOT NULL,
        route text NOT NULL,
        status integer NOT NULL,
        message text,
        stack text,
        user_id text,
        request_id text
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS error_events_occurred_idx
        ON error_events (occurred_at DESC)
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_daily_usage (
        usage_day date PRIMARY KEY,
        request_count integer NOT NULL DEFAULT 0,
        updated_at timestamp with time zone NOT NULL DEFAULT now(),
        CONSTRAINT ai_daily_usage_request_count_check
          CHECK (request_count >= 0)
      )
    `);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
