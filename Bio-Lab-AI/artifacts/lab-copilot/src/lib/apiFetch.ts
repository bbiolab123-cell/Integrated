// Demo application attribution: made by Srivanth Dasu.
// Drop-in replacement for `fetch` for calls to the API server.
//
// Why this exists: the generated API client (@workspace/api-client-react) routes
// every request through customFetch, which (a) prepends VITE_API_URL so calls go
// to the Render backend instead of the Vercel frontend origin, and (b) attaches
// the Clerk bearer token. Hand-written `fetch("/api/...")` calls bypassed both,
// so in production they hit Vercel (404/405) and, even when pointed at Render,
// were rejected with 401 because no token was attached.
//
// apiFetch mirrors that behavior but returns a normal Response, so existing call
// sites that use `.ok`, `.json()`, `.then(r => r.json())`, etc. keep working
// unchanged — only the host and auth header are added.

const BASE = (import.meta.env.VITE_API_URL ?? "").replace(/\/+$/, "");

type ClerkGlobal = {
  session?: { getToken?: () => Promise<string | null> };
};

async function getClerkToken(): Promise<string | null> {
  try {
    const clerk = (window as unknown as { Clerk?: ClerkGlobal }).Clerk;
    const token = await clerk?.session?.getToken?.();
    return token ?? null;
  } catch {
    return null;
  }
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!path.startsWith("/api/")) {
    throw new TypeError("apiFetch only accepts same-app /api/ paths.");
  }
  const headers = new Headers(init.headers);

  if (!headers.has("authorization")) {
    const token = await getClerkToken();
    if (token) headers.set("authorization", `Bearer ${token}`);
  }

  const url = `${BASE}${path}`;

  return fetch(url, { ...init, headers });
}
