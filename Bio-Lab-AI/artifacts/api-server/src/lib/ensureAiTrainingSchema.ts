import { pool } from "@workspace/db";

/**
 * Compatibility migration for deployments that predate the provider-neutral
 * AI and training-feedback tables. The current hosting setup starts the
 * bundled API directly, so there is no separate migration command to run.
 *
 * Every statement is additive and idempotent. This lets old production
 * databases upgrade safely while fresh databases still use the Drizzle schema
 * as their source of truth.
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
        ADD COLUMN IF NOT EXISTS protocol_ai_request_id text
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
        schema_version integer NOT NULL DEFAULT 1,
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
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
