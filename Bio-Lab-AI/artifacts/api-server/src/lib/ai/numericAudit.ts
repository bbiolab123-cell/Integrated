const NUMBER_RE = /(?<![A-Za-z])[-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?%?/gi;
const SAFE_STRUCTURAL_NUMBERS = new Set(["0", "1", "2", "3", "4", "5", "6", "7", "8", "0.5", "100"]);

function normalizeNumber(token: string): string {
  return token.toLowerCase().replace(/%$/, "").replace(/^\+/, "");
}

export function unsupportedNumericClaims(output: string, source: string): string[] {
  const sourceNumbers = new Set((source.match(NUMBER_RE) ?? []).map(normalizeNumber));
  const unsupported = new Set<string>();
  for (const raw of output.match(NUMBER_RE) ?? []) {
    const normalized = normalizeNumber(raw);
    if (SAFE_STRUCTURAL_NUMBERS.has(normalized) || sourceNumbers.has(normalized)) continue;
    const index = output.indexOf(raw);
    const nearby = output.slice(Math.max(0, index - 45), index + raw.length + 45).toLowerCase();
    if (nearby.includes("derived") || nearby.includes("calculated") || nearby.includes("approximately") || nearby.includes("~")) continue;
    unsupported.add(raw);
  }
  return Array.from(unsupported);
}

export function numericAuditNotice(output: string, source: string): string | null {
  const unsupported = unsupportedNumericClaims(output, source);
  if (!unsupported.length) return null;
  return `Verify derived numeric claims before bench use (${unsupported.slice(0, 8).join(", ")}).`;
}
