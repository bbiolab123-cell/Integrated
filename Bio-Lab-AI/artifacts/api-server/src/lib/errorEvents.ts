// Server-side error recording.
//
// Until now a failure in production was visible only in Render's log stream,
// which nobody watches and which the free plan does not retain. A scientist
// hitting a bug had no path to telling you beyond emailing. This persists 5xx
// responses so they can be read back in the admin panel.
//
// Two rules shape everything here:
//   1. Recording must never break the request that failed. Every write is
//      fire-and-forget and swallows its own errors.
//   2. It stores what is needed to debug, not what the user typed. No request
//      bodies, no query strings, no headers — those carry the science and,
//      potentially, personal data.

import { pool } from "@workspace/db";

const MESSAGE_LIMIT = 500;
const STACK_LIMIT = 2_000;
const RETENTION_DAYS = 14;
// Pruning on every insert would double the write cost of an outage, which is
// exactly when the table grows fastest. Amortise it instead.
const PRUNE_PROBABILITY = 0.02;

export interface ErrorEventInput {
  method: string;
  path: string;
  status: number;
  message?: string | null;
  stack?: string | null;
  userId?: string | null;
  requestId?: string | null;
}

function clamp(value: string | null | undefined, limit: number): string | null {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

/**
 * Collapse the concrete path into the route shape.
 *
 * `/api/experiments/41/layout` and `/api/experiments/78/layout` are the same
 * bug; keeping the ids apart would scatter one failure across every row the
 * user happens to own, and the id is itself a small leak.
 */
export function normalizeRoute(path: string): string {
  return path
    .split("?")[0]
    .split("/")
    .map((segment) => {
      if (/^\d+$/.test(segment)) return ":id";
      // Share tokens and other long opaque strings.
      if (/^[a-f0-9]{32,}$/i.test(segment)) return ":token";
      return segment;
    })
    .join("/");
}

export async function recordErrorEvent(input: ErrorEventInput): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO error_events (method, route, status, message, stack, user_id, request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.method.slice(0, 10),
        normalizeRoute(input.path).slice(0, 300),
        input.status,
        clamp(input.message, MESSAGE_LIMIT),
        clamp(input.stack, STACK_LIMIT),
        input.userId ?? null,
        input.requestId ?? null,
      ],
    );

    if (Math.random() < PRUNE_PROBABILITY) {
      await pool.query(
        `DELETE FROM error_events WHERE occurred_at < now() - interval '${RETENTION_DAYS} days'`,
      );
    }
  } catch {
    // Never let monitoring take down the thing it monitors. The request has
    // already failed; failing to record that is not worth a second failure.
  }
}
