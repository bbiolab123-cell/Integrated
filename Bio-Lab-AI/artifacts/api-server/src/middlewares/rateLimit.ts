import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { logger } from "../lib/logger";
import { getRequestUserId } from "../lib/requestUser";
import { readPositiveIntEnv } from "../lib/requestLimits";

type RateLimitOptions = {
  windowMs: number;
  max: number;
  keyPrefix: string;
  message: string;
};

type Bucket = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, Bucket>();
const MAX_TRACKED_BUCKETS = 20_000;

function requestLogger(req: Request) {
  return req.log ?? logger;
}

function pruneExpiredBuckets(now: number): void {
  for (const [bucketKey, value] of buckets) {
    if (value.resetAt <= now) buckets.delete(bucketKey);
  }
}

function clientKey(req: Request, prefix: string): string {
  try {
    return `${prefix}:user:${getRequestUserId(req)}`;
  } catch {
    return `${prefix}:ip:${req.ip ?? req.socket.remoteAddress ?? "unknown"}`;
  }
}

function createRateLimiter(options: RateLimitOptions) {
  return function rateLimiter(req: Request, res: Response, next: NextFunction) {
    const now = Date.now();
    const key = clientKey(req, options.keyPrefix);
    const current = buckets.get(key);

    if (!current && buckets.size >= MAX_TRACKED_BUCKETS) {
      pruneExpiredBuckets(now);
      if (buckets.size >= MAX_TRACKED_BUCKETS) {
        requestLogger(req).warn(
          {
            rateLimitScope: options.keyPrefix,
            trackedBuckets: buckets.size,
            maxTrackedBuckets: MAX_TRACKED_BUCKETS,
            retryAfterSeconds: 60,
            retryExpected: true,
          },
          "The request was rejected because the in-memory rate-limit tracker reached its client-capacity guard; existing traffic can continue, but new client identities are temporarily blocked. Inspect traffic cardinality or abuse and retry after expired buckets are pruned.",
        );
        res.setHeader("Retry-After", "60");
        res.status(429).json({ error: "Request capacity reached. Please try again shortly." });
        return;
      }
    }

    const bucket = current && current.resetAt > now
      ? current
      : { count: 0, resetAt: now + options.windowMs };

    bucket.count += 1;
    buckets.set(key, bucket);

    const remaining = Math.max(0, options.max - bucket.count);
    const resetSeconds = Math.ceil((bucket.resetAt - now) / 1000);
    res.setHeader("RateLimit-Limit", String(options.max));
    res.setHeader("RateLimit-Remaining", String(remaining));
    res.setHeader("RateLimit-Reset", String(resetSeconds));

    if (bucket.count > options.max) {
      requestLogger(req).warn(
        {
          rateLimitScope: options.keyPrefix,
          requestCount: bucket.count,
          requestLimit: options.max,
          retryAfterSeconds: resetSeconds,
          retryExpected: true,
        },
        "The request was rejected because this client exceeded the configured rate limit; this is normal abuse protection, not a service failure. Retry after the advertised interval or investigate a client that is sending unexpected traffic.",
      );
      res.setHeader("Retry-After", String(resetSeconds));
      res.status(429).json({
        error: options.message,
        retry_after_seconds: resetSeconds,
      });
      return;
    }

    if (buckets.size > 10_000) pruneExpiredBuckets(now);

    next();
  };
}

// Broad abuse protection is IP-based because this middleware runs before auth.
// Authenticated AI endpoints add the stricter user-based limiter below.
export const apiRateLimiter = createRateLimiter({
  keyPrefix: "api",
  windowMs: readPositiveIntEnv("API_RATE_LIMIT_WINDOW_MS", 15 * 60 * 1000),
  max: readPositiveIntEnv("API_RATE_LIMIT_MAX", 600),
  message: "Too many requests. Please wait before trying again.",
});

export const aiRateLimiter = createRateLimiter({
  keyPrefix: "ai",
  windowMs: readPositiveIntEnv("AI_RATE_LIMIT_WINDOW_MS", 15 * 60 * 1000),
  max: readPositiveIntEnv("AI_RATE_LIMIT_MAX", 20),
  message: "Too many AI requests. Please wait a bit before asking the copilot again.",
});

export type AiDailyQuotaResult = {
  allowed: boolean;
  used: number;
};

export type AiDailyQuotaStore = {
  consume(day: string, limit: number): Promise<AiDailyQuotaResult>;
};

const postgresAiDailyQuotaStore: AiDailyQuotaStore = {
  async consume(day, limit) {
    // Keep the database module lazy so pure unit tests can exercise quota and
    // rollout behavior without needing a live DATABASE_URL.
    const { pool } = await import("@workspace/db");
    const result = await pool.query<{ request_count: number }>(`
      INSERT INTO ai_daily_usage (usage_day, request_count, updated_at)
      VALUES ($1::date, 1, now())
      ON CONFLICT (usage_day) DO UPDATE
        SET request_count = ai_daily_usage.request_count + 1,
            updated_at = now()
        WHERE ai_daily_usage.request_count < $2
      RETURNING request_count
    `, [day, limit]);
    if (result.rowCount && result.rows[0]) {
      return { allowed: true, used: Number(result.rows[0].request_count) };
    }
    return { allowed: false, used: limit };
  },
};

let aiDailyQuotaStore: AiDailyQuotaStore = postgresAiDailyQuotaStore;

export function setAiDailyQuotaStoreForTests(store: AiDailyQuotaStore | null): void {
  aiDailyQuotaStore = store ?? postgresAiDailyQuotaStore;
}

function aiRolloutEnabled(req: Request): boolean {
  const userId = getRequestUserId(req);
  const owners = new Set(
    `${process.env.AI_ROLLOUT_OWNER_USER_IDS ?? ""},${process.env.AI_TRAINING_ADMIN_USER_IDS ?? ""}`
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
  if (owners.has(userId)) return true;
  const configured = Number(process.env.AI_ROLLOUT_PERCENT ?? 100);
  const percentage = Number.isFinite(configured) ? Math.min(100, Math.max(0, Math.floor(configured))) : 100;
  if (percentage === 0) return false;
  if (percentage === 100) return true;
  const bucket = Number.parseInt(createHash("sha256").update(userId).digest("hex").slice(0, 8), 16) % 100;
  return bucket < percentage;
}

/**
 * Conservative global request cap protecting the free Workers AI allowance.
 * Consumption is atomic in Postgres, so server restarts and horizontal scaling
 * cannot reset or race the counter.
 */
export async function aiDailyQuota(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!aiRolloutEnabled(req)) {
    requestLogger(req).info(
      { rolloutPercent: Number(process.env.AI_ROLLOUT_PERCENT ?? 100), retryExpected: false },
      "AI work was intentionally skipped because this account is outside the configured rollout; the rest of the API is unaffected. No action is needed unless this account should be included in the rollout.",
    );
    res.status(503).json({
      error: "Bio-Lab AI is not enabled for this account during the current rollout stage.",
      code: "AI_ROLLOUT_UNAVAILABLE",
    });
    return;
  }
  const day = new Date().toISOString().slice(0, 10);
  const limit = readPositiveIntEnv("AI_DAILY_REQUEST_LIMIT", 50);
  let quota: AiDailyQuotaResult;
  try {
    quota = await aiDailyQuotaStore.consume(day, limit);
  } catch (error) {
    requestLogger(req).error(
      { err: error, database: "primary", quotaDay: day, requestLimit: limit, retryExpected: true },
      "The AI request was blocked because the daily usage counter could not be read or updated atomically; failing closed prevents untracked provider usage. Check database connectivity and the ai_daily_usage table, then retry.",
    );
    res.status(503).json({
      error: "Bio-Lab AI is temporarily unavailable because its usage limit could not be verified.",
      code: "AI_QUOTA_UNAVAILABLE",
    });
    return;
  }

  if (!quota.allowed) {
    const resetAt = new Date(`${day}T00:00:00.000Z`);
    resetAt.setUTCDate(resetAt.getUTCDate() + 1);
    const retryAfter = Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000));
    requestLogger(req).warn(
      {
        quotaDay: day,
        requestCount: quota.used,
        requestLimit: limit,
        retryAfterSeconds: retryAfter,
        retryExpected: true,
      },
      "The AI request was rejected because the shared daily provider quota is exhausted; this is an expected capacity limit and non-AI features remain available. Retry after the UTC reset or raise the configured limit after verifying provider capacity.",
    );
    res.setHeader("Retry-After", String(retryAfter));
    res.setHeader("AI-Daily-Limit", String(limit));
    res.setHeader("AI-Daily-Remaining", "0");
    res.status(429).json({
      error: "The free daily AI limit has been reached. Please try again after the UTC reset.",
      retry_after_seconds: retryAfter,
    });
    return;
  }
  res.setHeader("AI-Daily-Limit", String(limit));
  res.setHeader("AI-Daily-Remaining", String(Math.max(0, limit - quota.used)));
  next();
}
