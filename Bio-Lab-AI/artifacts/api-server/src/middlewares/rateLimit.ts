import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
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

let dailyAiUsage = { day: "", count: 0 };

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
 * Conservative request cap protecting the free Workers AI allowance. This is
 * intentionally global: a public deployment must stop before one busy account
 * can create provider charges for everyone. Railway currently runs one API
 * instance; move this counter to Postgres before horizontally scaling.
 */
export function aiDailyQuota(req: Request, res: Response, next: NextFunction) {
  if (!aiRolloutEnabled(req)) {
    res.status(503).json({
      error: "Bio-Lab AI is not enabled for this account during the current rollout stage.",
      code: "AI_ROLLOUT_UNAVAILABLE",
    });
    return;
  }
  const day = new Date().toISOString().slice(0, 10);
  if (dailyAiUsage.day !== day) dailyAiUsage = { day, count: 0 };
  const limit = readPositiveIntEnv("AI_DAILY_REQUEST_LIMIT", 50);
  if (dailyAiUsage.count >= limit) {
    const resetAt = new Date(`${day}T00:00:00.000Z`);
    resetAt.setUTCDate(resetAt.getUTCDate() + 1);
    const retryAfter = Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000));
    res.setHeader("Retry-After", String(retryAfter));
    res.setHeader("AI-Daily-Limit", String(limit));
    res.setHeader("AI-Daily-Remaining", "0");
    res.status(429).json({
      error: "The free daily AI limit has been reached. Please try again after the UTC reset.",
      retry_after_seconds: retryAfter,
    });
    return;
  }
  dailyAiUsage.count += 1;
  res.setHeader("AI-Daily-Limit", String(limit));
  res.setHeader("AI-Daily-Remaining", String(Math.max(0, limit - dailyAiUsage.count)));
  next();
}
