import { logger } from "./logger";

const DEFAULT_AI_INPUT_MAX_CHARS = 8_000;
const invalidSettingsLogged = new Set<string>();

export function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (!raw || (Number.isFinite(parsed) && parsed > 0)) return raw ? parsed : fallback;
  if (!invalidSettingsLogged.has(name)) {
    invalidSettingsLogged.add(name);
    logger.warn(
      { setting: name, configuredValue: raw, fallbackValue: fallback, fallback: "use_default_positive_integer", retryExpected: false },
      "A request-limit setting is not a positive integer, so the safe default is being used and requests can continue normally. Correct the environment variable before the next process restart if a custom limit was intended.",
    );
  }
  return fallback;
}

export const MAX_AI_INPUT_CHARS = readPositiveIntEnv(
  "AI_INPUT_MAX_CHARS",
  DEFAULT_AI_INPUT_MAX_CHARS,
);

export function assertMaxChars(value: string, label: string, max = MAX_AI_INPUT_CHARS): string {
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new Error(`${label} is too long. Maximum length is ${max} characters.`);
  }
  return trimmed;
}
