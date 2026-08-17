import type { Request } from "express";
import { getAuth } from "@clerk/express";

type RequestWithUser = Request & { userId?: string };
type SessionClaims = Record<string, unknown>;

function getAuthSafe(req: Request) {
  try {
    return getAuth(req);
  } catch (err) {
    req.log?.warn(
      { err, authProvider: "clerk", retryExpected: false },
      "The request authentication context could not be read, so no authenticated user can be resolved from Clerk. The request will be denied unless a trusted local user context exists; verify Clerk middleware configuration and request credentials.",
    );
    return null;
  }
}

export function getRequestUserId(req: Request): string {
  const localUserId = (req as RequestWithUser).userId;
  if (localUserId) return localUserId;

  const auth = getAuthSafe(req);
  const userId = auth?.userId;
  if (userId) return userId;

  throw new Error("Authenticated user id is unavailable");
}

export function getRequestUserEmail(req: Request): string {
  const claims = (getAuthSafe(req)?.sessionClaims ?? {}) as SessionClaims;
  const values = [
    claims.email,
    claims.primary_email_address,
    claims.email_address,
    claims["https://labcopilot.app/email"],
  ];

  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim().toLowerCase();
  }

  return "";
}
