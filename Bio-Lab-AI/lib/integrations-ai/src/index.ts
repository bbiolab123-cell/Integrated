import type { AiProvider } from "./provider";
import { CloudflareAiProvider } from "./cloudflare";

let cachedProvider: AiProvider | null = null;

export function getAiProvider(env: NodeJS.ProcessEnv = process.env): AiProvider {
  if (cachedProvider) return cachedProvider;
  const provider = (env.AI_PROVIDER?.trim().toLowerCase() || "cloudflare");
  if (provider !== "cloudflare") {
    throw new Error(`Unsupported AI_PROVIDER "${provider}". Supported providers: cloudflare.`);
  }
  cachedProvider = new CloudflareAiProvider(env);
  return cachedProvider;
}

export function setAiProviderForTests(provider: AiProvider | null): void {
  cachedProvider = provider;
}

export * from "./provider";
export * from "./cloudflare";
