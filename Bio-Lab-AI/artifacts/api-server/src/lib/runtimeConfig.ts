import { assertSafeAiProviderConfiguration } from "@workspace/integrations-ai";

export const isProduction = process.env.NODE_ENV === "production";
export const isClerkConfigured = Boolean(process.env.CLERK_SECRET_KEY?.trim());

// Demo mode must be explicitly enabled and is never available in production.
// This prevents a missing secret from silently turning an API on the local
// network into a shared unauthenticated workspace.
export const isDemoMode =
  !isProduction &&
  !isClerkConfigured &&
  process.env.ENABLE_DEMO_MODE === "true";

export function assertSafeAuthConfiguration(): void {
  if (isClerkConfigured || isDemoMode) return;

  throw new Error(
    isProduction
      ? "CLERK_SECRET_KEY is required when NODE_ENV=production"
      : "Authentication is not configured. Set CLERK_SECRET_KEY, or explicitly set ENABLE_DEMO_MODE=true for local-only demo use.",
  );
}

export function assertSafeAiConfiguration(): void {
  if (!isProduction) return;
  assertSafeAiProviderConfiguration(process.env);
}
