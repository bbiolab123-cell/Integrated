import express, { type ErrorRequestHandler, type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import router from "./routes";
import { logger } from "./lib/logger";
import { apiRateLimiter } from "./middlewares/rateLimit";
import { assertSafeAuthConfiguration, isClerkConfigured, isDemoMode, isProduction } from "./lib/runtimeConfig";

const app: Express = express();
assertSafeAuthConfiguration();

app.disable("x-powered-by");
if (isProduction) app.set("trust proxy", 1);

const defaultCorsOrigins = ["https://biolab-copilot.vercel.app"];

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
  callback(null, false);
}

const corsOptions = {
  credentials: true,
  origin: resolveCorsOrigin,
  methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type", "If-None-Match"],
  exposedHeaders: ["RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset", "Retry-After", "AI-Daily-Limit", "AI-Daily-Remaining"],
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
  logger.warn("Explicit local demo mode enabled — authentication is disabled");
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
  req.log.error({ err, statusCode: safeStatus }, "Unhandled API error");
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
