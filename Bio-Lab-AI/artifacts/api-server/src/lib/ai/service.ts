import { randomUUID } from "node:crypto";
import { db, aiTrainingExamples } from "@workspace/db";
import {
  AiProviderError,
  getAiProvider,
  type AiGenerateRequest,
  type AiMessage,
  type AiStreamResult,
} from "@workspace/integrations-ai";
import type { ZodType } from "zod";
import { logger } from "../logger";
import { sanitizeAiText } from "./sanitize";

export const AI_TASK_TYPES = [
  "experiment_analysis",
  "data_analysis",
  "experiment_chat",
  "experiment_comparison",
  "protocol_generation",
  "sop_structuring",
  "project_chat",
  "project_synthesis",
  "general_chat",
] as const;

export type AiTaskType = typeof AI_TASK_TYPES[number];

export type AiCallContext = {
  taskType: AiTaskType;
  userId: string;
  experimentId?: number;
  projectId?: number;
  sensitiveTerms?: string[];
};

export type AiTextRequest = AiCallContext & {
  systemInstruction: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  maxTokens?: number;
  temperature?: number;
};

export type AiTextResult = {
  text: string;
  requestId: string;
  model: string;
};

export interface RecordedAiStream extends AiStreamResult {
  requestId: string;
  model: string;
}

const DEFAULT_ATTEMPTS = 4;

export class AiValidationError extends Error {
  readonly statusCode = 502;
}

function buildMessages(request: AiTextRequest): AiMessage[] {
  const terms = request.sensitiveTerms ?? [];
  const taskTag = `<TASK=${request.taskType}>`;
  return [
    { role: "system", content: `${taskTag}\n${sanitizeAiText(request.systemInstruction, terms)}` },
    ...request.messages.map((message) => ({
      role: message.role,
      content: sanitizeAiText(message.content, terms),
    })),
  ];
}

function isRetryable(error: unknown): boolean {
  return error instanceof AiProviderError && error.retryable;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function withRetry<T>(operation: () => Promise<T>, attempts = DEFAULT_ATTEMPTS): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === attempts - 1) throw error;
      const delay = 500 * 2 ** attempt + Math.floor(Math.random() * 250);
      logger.warn({ attempt: attempt + 1, delay }, "AI provider transient error — retrying");
      await sleep(delay);
    }
  }
  throw lastError;
}

async function recordGeneration(
  context: AiCallContext,
  requestId: string,
  messages: AiMessage[],
  output: string,
): Promise<void> {
  if (process.env.AI_RECORD_GENERATIONS === "false") return;
  try {
    await db.insert(aiTrainingExamples).values({
      request_id: requestId,
      user_id: context.userId,
      task_type: context.taskType,
      input_json: JSON.stringify(messages),
      model_output: output,
      experiment_id: context.experimentId ?? null,
      project_id: context.projectId ?? null,
    }).onConflictDoNothing();
  } catch (error) {
    // A deployment may serve traffic briefly before the Drizzle schema push.
    // AI generation should still work; the missing training record is logged
    // without ever logging prompt or response bodies.
    logger.warn({ error, requestId, taskType: context.taskType }, "Could not record AI generation metadata");
  }
}

function providerRequest(request: AiTextRequest, requestId: string, messages: AiMessage[], jsonMode = false): AiGenerateRequest {
  return {
    requestId,
    messages,
    maxTokens: request.maxTokens,
    temperature: request.temperature,
    jsonMode,
  };
}

export async function generateAiText(request: AiTextRequest): Promise<AiTextResult> {
  const provider = getAiProvider();
  const requestId = randomUUID();
  const messages = buildMessages(request);
  const result = await withRetry(() => provider.generate(providerRequest(request, requestId, messages)));
  await recordGeneration(request, requestId, messages, result.text);
  return { text: result.text, requestId, model: result.model };
}

export async function streamAiText(request: AiTextRequest): Promise<RecordedAiStream> {
  const provider = getAiProvider();
  const requestId = randomUUID();
  const messages = buildMessages(request);
  const source = await withRetry(() => provider.stream(providerRequest(request, requestId, messages)));
  const recorded = async function* () {
    let output = "";
    for await (const chunk of source) {
      output += chunk.text;
      yield chunk;
    }
    if (output.trim()) await recordGeneration(request, requestId, messages, output);
  };
  return Object.assign(recorded(), {
    requestId,
    model: source.model,
  });
}

function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const firstObject = trimmed.indexOf("{");
    const lastObject = trimmed.lastIndexOf("}");
    if (firstObject >= 0 && lastObject > firstObject) return JSON.parse(trimmed.slice(firstObject, lastObject + 1));
    const firstArray = trimmed.indexOf("[");
    const lastArray = trimmed.lastIndexOf("]");
    if (firstArray >= 0 && lastArray > firstArray) return JSON.parse(trimmed.slice(firstArray, lastArray + 1));
    throw new AiValidationError("The AI returned malformed JSON.");
  }
}

export async function generateAiJson<T>(request: AiTextRequest, schema: ZodType<T>): Promise<AiTextResult & { data: T }> {
  const provider = getAiProvider();
  const requestId = randomUUID();
  const messages = buildMessages(request);
  let lastText = "";
  let validationMessage = "";

  for (let validationAttempt = 0; validationAttempt < 2; validationAttempt++) {
    const attemptMessages: AiMessage[] = validationAttempt === 0
      ? messages
      : [
          ...messages,
          { role: "assistant", content: lastText },
          {
            role: "user",
            content: `The previous response was invalid (${validationMessage}). Return a corrected JSON object only.`,
          },
        ];
    const result = await withRetry(() => provider.generate(providerRequest(request, requestId, attemptMessages, true)));
    lastText = result.text;
    try {
      const parsed = schema.safeParse(extractJson(lastText));
      if (parsed.success) {
        await recordGeneration(request, requestId, messages, JSON.stringify(parsed.data));
        return { text: JSON.stringify(parsed.data), data: parsed.data, requestId, model: result.model };
      }
      validationMessage = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    } catch (error) {
      validationMessage = error instanceof Error ? error.message : "malformed JSON";
    }
  }
  throw new AiValidationError(`The AI could not produce valid structured output: ${validationMessage}`);
}

export function aiErrorStatus(error: unknown): number {
  if (error instanceof AiProviderError || error instanceof AiValidationError) return error.statusCode;
  return 500;
}
