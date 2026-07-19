export type AiRole = "system" | "user" | "assistant";

export interface AiMessage {
  role: AiRole;
  content: string;
}

export interface AiGenerateRequest {
  requestId: string;
  messages: AiMessage[];
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
}

export interface AiGenerateResult {
  requestId: string;
  model: string;
  text: string;
}

export interface AiStreamChunk {
  text: string;
}

export interface AiStreamResult extends AsyncIterable<AiStreamChunk> {
  requestId: string;
  model: string;
}

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  generate(request: AiGenerateRequest): Promise<AiGenerateResult>;
  stream(request: AiGenerateRequest): Promise<AiStreamResult>;
}

export class AiProviderError extends Error {
  constructor(
    message: string,
    readonly statusCode = 502,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "AiProviderError";
  }
}
