import type { Request, Response, NextFunction } from "express";
import { clerkClient } from "@clerk/express";
import { getRequestUserEmail, getRequestUserId } from "../lib/requestUser";
import { isDemoMode } from "../lib/runtimeConfig";

const adminEmailsRaw = process.env.ADMIN_EMAILS ?? "";
const APPROVED_ADMIN_EMAILS = new Set(
  adminEmailsRaw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
);

const normalizeEmail = (value: string) => value.trim().toLowerCase();

async function getVerifiedAdminEmail(req: Request): Promise<string> {
  const claimEmail = getRequestUserEmail(req);
  if (claimEmail) return claimEmail;
  if (isDemoMode) return normalizeEmail(process.env.DEMO_ADMIN_EMAIL || "");

  try {
    const user = await clerkClient.users.getUser(getRequestUserId(req));
    const primaryEmail =
      user.emailAddresses.find((address) => address.id === user.primaryEmailAddressId) ??
      user.emailAddresses[0];
    return normalizeEmail(primaryEmail?.emailAddress || "");
  } catch (err) {
    req.log.warn(
      { err, authProvider: "clerk", userId: getRequestUserId(req), retryExpected: true },
      "Admin email verification could not reach or read the Clerk user record, so this admin request will be denied. Check Clerk availability and the user's primary email record before retrying.",
    );
    return "";
  }
}

export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const email = await getVerifiedAdminEmail(req);
  if (!APPROVED_ADMIN_EMAILS.has(email)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  (req as Request & { adminEmail: string }).adminEmail = email;
  next();
}

const TRAINING_ADMIN_USER_IDS = new Set(
  (process.env.AI_TRAINING_ADMIN_USER_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
);

/** Training exports use stable Clerk user IDs, not mutable email claims. */
export function requireTrainingAdmin(req: Request, res: Response, next: NextFunction) {
  const userId = getRequestUserId(req);
  if (!TRAINING_ADMIN_USER_IDS.has(userId)) {
    res.status(403).json({ error: "Training-admin access is required." });
    return;
  }
  next();
}
