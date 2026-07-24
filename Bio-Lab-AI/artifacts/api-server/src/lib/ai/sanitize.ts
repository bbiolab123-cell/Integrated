const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const API_KEY_RE = /\b(?:sk|AIza|hf|cf)[_-][A-Za-z0-9_-]{16,}\b/g;
const CLERK_USER_RE = /\buser_[A-Za-z0-9]{8,}\b/g;
const FILE_RE = /\b[^\s/\\]{1,120}\.(?:csv|tsv|txt|xlsx|xls|docx|pdf)\b/gi;
const PATH_RE = /(?:\/[A-Za-z0-9._ -]+){2,}/g;
const CREDENTIAL_ASSIGNMENT_RE = /\b(?:api[_-]?(?:key|token)|access[_-]?token|password|secret|database_url)\s*[:=]\s*["']?[^\s"',;]+/gi;
const SENSITIVE_KEYS = new Set([
  "user_id", "clerk_user_id", "email", "file_name", "filename", "plate_name",
  "project_name", "owner_name", "author_name", "created_by", "password", "secret",
  "token", "api_key", "api_token", "credential", "credentials", "path",
]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function sanitizeAiText(value: string, sensitiveTerms: string[] = []): string {
  let sanitized = value
    .replace(EMAIL_RE, "[redacted-email]")
    .replace(BEARER_RE, "Bearer [redacted-secret]")
    .replace(API_KEY_RE, "[redacted-secret]")
    .replace(CREDENTIAL_ASSIGNMENT_RE, "[redacted-credential]")
    .replace(CLERK_USER_RE, "[redacted-user]")
    .replace(FILE_RE, "[redacted-file]")
    .replace(PATH_RE, "[redacted-path]");

  const terms = Array.from(new Set(sensitiveTerms.map((term) => term.trim()).filter((term) => term.length >= 3)))
    .sort((a, b) => b.length - a.length);
  for (const term of terms) {
    sanitized = sanitized.replace(new RegExp(escapeRegExp(term), "gi"), "[redacted-name]");
  }
  return sanitized;
}

export function sanitizeAiValue(value: unknown, sensitiveTerms: string[] = []): unknown {
  if (typeof value === "string") return sanitizeAiText(value, sensitiveTerms);
  if (Array.isArray(value)) return value.map((item) => sanitizeAiValue(item, sensitiveTerms));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !SENSITIVE_KEYS.has(key.toLowerCase()))
        .map(([key, nested]) => [key, sanitizeAiValue(nested, sensitiveTerms)]),
    );
  }
  return value;
}
