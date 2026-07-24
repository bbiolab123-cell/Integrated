import {
  AiProviderError,
  type AiGenerateRequest,
  type AiGenerateResult,
  type AiMessage,
  type AiProvider,
  type AiStreamChunk,
  type AiStreamResult,
} from "./provider";

const DEFAULT_MODEL = "@cf/mistral/mistral-7b-instruct-v0.2-lora";
const DEFAULT_TIMEOUT_MS = 90_000;

type CloudflareEnvelope = {
  success?: boolean;
  errors?: Array<{ message?: string }>;
  result?: { response?: string } | string;
};

function required(name: string, value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) throw new AiProviderError(`${name} is required to use Cloudflare Workers AI.`, 503, false);
  return normalized;
}

function normalizeMessages(messages: AiMessage[]): AiMessage[] {
  return messages.filter((message) => message.content.trim().length > 0);
}

function responseText(payload: CloudflareEnvelope): string {
  if (typeof payload.result === "string") return payload.result;
  if (payload.result && typeof payload.result.response === "string") return payload.result.response;
  return "";
}

function errorMessage(payload: CloudflareEnvelope | null, fallback: string): string {
  const detail = payload?.errors?.map((error) => error.message).filter(Boolean).join("; ");
  return detail || fallback;
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function parseSseData(data: string): string {
  if (!data || data === "[DONE]") return "";
  try {
    const payload = JSON.parse(data) as { response?: unknown; result?: { response?: unknown } };
    if (typeof payload.response === "string") return payload.response;
    if (typeof payload.result?.response === "string") return payload.result.response;
  } catch {
    return data;
  }
  return "";
}

export class CloudflareAiProvider implements AiProvider {
  readonly name = "cloudflare";
  readonly model: string;
  private readonly accountId: string;
  private readonly apiToken: string;
  private readonly loraId?: string;
  private readonly timeoutMs: number;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.accountId = required("CLOUDFLARE_ACCOUNT_ID", env.CLOUDFLARE_ACCOUNT_ID);
    this.apiToken = required("CLOUDFLARE_API_TOKEN", env.CLOUDFLARE_API_TOKEN);
    this.model = env.CLOUDFLARE_MODEL?.trim() || DEFAULT_MODEL;
    this.loraId = env.CLOUDFLARE_LORA_ID?.trim() || undefined;
    const parsedTimeout = Number(env.AI_PROVIDER_TIMEOUT_MS);
    this.timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : DEFAULT_TIMEOUT_MS;
  }

  private url(): string {
    return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.accountId)}/ai/run/${this.model}`;
  }

  private body(request: AiGenerateRequest, stream: boolean): Record<string, unknown> {
    return {
      messages: normalizeMessages(request.messages),
      max_tokens: request.maxTokens ?? 4096,
      temperature: request.temperature ?? 0.2,
      stream,
      ...(request.jsonMode ? { response_format: { type: "json_object" } } : {}),
      ...(this.loraId ? { lora: this.loraId, raw: true } : {}),
    };
  }

  private async request(request: AiGenerateRequest, stream: boolean): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.url(), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(this.body(request, stream)),
        signal: controller.signal,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as CloudflareEnvelope | null;
        throw new AiProviderError(
          errorMessage(payload, `Workers AI request failed with status ${response.status}.`),
          response.status === 429 ? 429 : 502,
          retryableStatus(response.status),
        );
      }
      return response;
    } catch (error) {
      if (error instanceof AiProviderError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new AiProviderError("Workers AI request timed out.", 504, true);
      }
      throw new AiProviderError("Could not reach Cloudflare Workers AI.", 502, true);
    } finally {
      clearTimeout(timeout);
    }
  }

  async generate(request: AiGenerateRequest): Promise<AiGenerateResult> {
    const response = await this.request(request, false);
    const payload = await response.json().catch(() => null) as CloudflareEnvelope | null;
    if (!payload?.success && payload?.success !== undefined) {
      throw new AiProviderError(errorMessage(payload, "Workers AI returned an unsuccessful response."), 502, false);
    }
    const text = payload ? responseText(payload) : "";
    if (!text.trim()) throw new AiProviderError("Workers AI returned an empty response.", 502, true);
    return { requestId: request.requestId, model: this.model, text };
  }

  async stream(request: AiGenerateRequest): Promise<AiStreamResult> {
    const response = await this.request(request, true);
    if (!response.body) throw new AiProviderError("Workers AI returned no response stream.", 502, true);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    const chunks = async function* (): AsyncGenerator<AiStreamChunk> {
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const event of events) {
          const lines = event.split("\n");
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const text = parseSseData(line.slice(5).trim());
            if (text) yield { text };
          }
        }
      }
      const trailing = buffer.trim();
      if (trailing.startsWith("data:")) {
        const text = parseSseData(trailing.slice(5).trim());
        if (text) yield { text };
      }
    };

    return Object.assign(chunks(), {
      requestId: request.requestId,
      model: this.model,
    });
  }
}
