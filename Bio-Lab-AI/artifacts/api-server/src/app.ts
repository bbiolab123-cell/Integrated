import express, { type ErrorRequestHandler, type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { randomUUID } from "node:crypto";
import { clerkMiddleware } from "@clerk/express";
import router from "./routes";
import { logger } from "./lib/logger";
import { apiRateLimiter } from "./middlewares/rateLimit";
import {
  assertSafeAiConfiguration,
  assertSafeAuthConfiguration,
  isClerkConfigured,
  isDemoMode,
  isProduction,
} from "./lib/runtimeConfig";

const app: Express = express();
assertSafeAuthConfiguration();
assertSafeAiConfiguration();

app.disable("x-powered-by");
if (isProduction) app.set("trust proxy", 1);

const defaultCorsOrigins = ["https://biolab-copilot.vercel.app"];
const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TRACEPARENT_RE = /^00-([a-f0-9]{32})-[a-f0-9]{16}-[a-f0-9]{2}$/i;

function requestIdFromHeader(value: string | string[] | undefined): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && REQUEST_ID_RE.test(candidate) ? candidate : randomUUID();
}

function traceIdFromHeader(value: string | string[] | undefined): string | undefined {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate?.match(TRACEPARENT_RE)?.[1]?.toLowerCase();
}

function parseCorsOrigins(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

const configuredCorsOrigins = new Set([
  ...defaultCorsOrigins,
  ...parseCorsOrigins(process.env.CORS_ORIGINS),
  ...parseCorsOrigins(process.env.FRONTEND_ORIGIN),
]);

function isAllowedDevOrigin(origin: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
}

// Preview deployments are opt-in. Production defaults to exact origins only;
// otherwise any unrelated project hosted on vercel.app would be trusted.
function isAllowedVercelOrigin(origin: string): boolean {
  return process.env.ALLOW_VERCEL_PREVIEWS === "true" && /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin);
}

function resolveCorsOrigin(origin: string | undefined, callback: (err: Error | null, origin?: boolean | string) => void) {
  if (!origin) {
    callback(null, true);
    return;
  }
  if (
    configuredCorsOrigins.has(origin) ||
    isAllowedVercelOrigin(origin) ||
    (!isProduction && isAllowedDevOrigin(origin))
  ) {
    callback(null, origin);
    return;
  }
  logger.warn(
    { origin, policy: "cors", retryExpected: false },
    "A browser origin was not granted cross-origin access; this is an expected policy rejection for unapproved frontends. Add the exact trusted origin to CORS_ORIGINS or FRONTEND_ORIGIN only if access should be allowed.",
  );
  callback(null, false);
}

const corsOptions = {
  credentials: true,
  origin: resolveCorsOrigin,
  methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type", "If-None-Match", "X-Request-ID", "X-User-Email"],
  exposedHeaders: [
    "RateLimit-Limit",
    "RateLimit-Remaining",
    "RateLimit-Reset",
    "Retry-After",
    "AI-Daily-Limit",
    "AI-Daily-Remaining",
    "X-BioLab-Build",
    "X-Request-ID",
  ],
  maxAge: 600,
  optionsSuccessStatus: 204,
};

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }),
);

app.use(
  pinoHttp({
    logger,
    genReqId(req, res) {
      const requestId = requestIdFromHeader(req.headers["x-request-id"]);
      res.setHeader("X-Request-ID", requestId);
      return requestId;
    },
    customLogLevel(_req, res) {
      return res.statusCode >= 400 && res.statusCode < 500 ? "warn" : "info";
    },
    customSuccessMessage(_req, res) {
      if (res.statusCode >= 400) {
        return "HTTP request was rejected by validation, access policy, rate limiting, or resource state; this is usually an expected client-facing condition. Use the status and request fields to correct the request or determine when to retry.";
      }
      return "HTTP request completed successfully; no operator action is required.";
    },
    customErrorMessage() {
      return "HTTP request ended with a server error; use the request ID to find the correlated ERROR log, inspect the reported dependency or resource, and retry only after the cause is resolved.";
    },
    customProps(req) {
      const request = req as typeof req & { userId?: string; route?: { path?: string } };
      return {
        userId: request.userId,
        endpoint: request.route?.path ? `${request.baseUrl ?? ""}${request.route.path}` : undefined,
        traceId: traceIdFromHeader(request.headers.traceparent),
      };
    },
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(cors(corsOptions));
app.use(express.json({ limit: process.env.REQUEST_BODY_LIMIT ?? "5mb" }));
app.use(express.urlencoded({ extended: true, limit: process.env.REQUEST_BODY_LIMIT ?? "5mb" }));

app.use("/api", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.use("/api", apiRateLimiter);

// Only mount Clerk middleware when auth is configured.
// Without CLERK_SECRET_KEY the app runs in demo mode (see requireAuth.ts).
if (isClerkConfigured) {
  app.use(clerkMiddleware());
} else if (isDemoMode) {
  logger.warn(
    { authMode: "demo", environment: process.env.NODE_ENV ?? "development" },
    "Authentication is intentionally disabled for explicit local demo mode; all requests share the demo account. This is normal only on a trusted development machine—disable ENABLE_DEMO_MODE or configure Clerk before exposing the service.",
  );
}

app.use("/api", router);

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "API route not found" });
});

const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const status =
    typeof err === "object" && err !== null && "status" in err && typeof err.status === "number"
      ? err.status
      : 500;
  const safeStatus = status >= 400 && status < 600 ? status : 500;
  req.log.error(
    { err, statusCode: safeStatus, retryExpected: safeStatus >= 500 },
    "An API request reached the global error handler and could not be completed; the client received a sanitized error response. Inspect the attached error and affected request, then verify application inputs or downstream services before retrying.",
  );
  res.status(safeStatus).json({
    error: safeStatus === 413
      ? "Request body is too large"
      : safeStatus === 400
        ? "Invalid request body"
        : "Internal server error",
  });
};

app.use(errorHandler);

export default app;
