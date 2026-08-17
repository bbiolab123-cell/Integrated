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
import { TRAINING_DATASET_SCHEMA_VERSION, type AiTaskType } from "./tasks";

export { AI_TASK_TYPES, type AiTaskType } from "./tasks";

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

type AiRetryContext = {
  requestId: string;
  taskType: AiTaskType;
  provider: string;
  model: string;
  experimentId?: number;
  projectId?: number;
};

async function withRetry<T>(
  operation: () => Promise<T>,
  context: AiRetryContext,
  attempts = DEFAULT_ATTEMPTS,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === attempts - 1) throw error;
      const delay = 500 * 2 ** attempt + Math.floor(Math.random() * 250);
      logger.warn(
        {
          err: error,
          ...context,
          attempt: attempt + 1,
          maxAttempts: attempts,
          nextAttempt: attempt + 2,
          delayMs: delay,
          providerStatusCode: error instanceof AiProviderError ? error.statusCode : undefined,
          retryExpected: true,
        },
        "The AI provider request failed with a transient condition; no result has been returned yet, and an automatic retry is scheduled. If all attempts fail, inspect provider availability, rate limits, and network connectivity using the AI request ID.",
      );
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
  if (process.env.AI_RECORD_GENERATIONS === "false") {
    logger.info(
      {
        requestId,
        taskType: context.taskType,
        userId: context.userId,
        experimentId: context.experimentId,
        projectId: context.projectId,
        recordingEnabled: false,
      },
      "AI generation metadata was intentionally not stored because recording is disabled; the AI result itself remains valid. No action is needed unless feedback or training exports are expected for this deployment.",
    );
    return;
  }
  try {
    await db.insert(aiTrainingExamples).values({
      request_id: requestId,
      user_id: context.userId,
      task_type: context.taskType,
      input_json: JSON.stringify(messages),
      model_output: output,
      schema_version: TRAINING_DATASET_SCHEMA_VERSION,
      experiment_id: context.experimentId ?? null,
      project_id: context.projectId ?? null,
    }).onConflictDoNothing();
  } catch (error) {
    // A deployment may serve traffic briefly before the Drizzle schema push.
    // AI generation should still work; the missing training record is logged
    // without ever logging prompt or response bodies.
    logger.warn(
      {
        err: error,
        requestId,
        taskType: context.taskType,
        userId: context.userId,
        experimentId: context.experimentId,
        projectId: context.projectId,
        database: "primary",
        retryExpected: false,
      },
      "The AI result was returned, but its metadata could not be stored for feedback or training; user-facing generation is not affected. Check database connectivity and the ai_training_examples schema, then decide whether the missing record requires manual recovery.",
    );
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
  const retryContext = {
    requestId,
    taskType: request.taskType,
    provider: provider.name,
    model: provider.model,
    experimentId: request.experimentId,
    projectId: request.projectId,
  };
  const result = await withRetry(
    () => provider.generate(providerRequest(request, requestId, messages)),
    retryContext,
  );
  await recordGeneration(request, requestId, messages, result.text);
  return { text: result.text, requestId, model: result.model };
}

export async function streamAiText(request: AiTextRequest): Promise<RecordedAiStream> {
  const provider = getAiProvider();
  const requestId = randomUUID();
  const messages = buildMessages(request);
  const retryContext = {
    requestId,
    taskType: request.taskType,
    provider: provider.name,
    model: provider.model,
    experimentId: request.experimentId,
    projectId: request.projectId,
  };
  const source = await withRetry(
    () => provider.stream(providerRequest(request, requestId, messages)),
    retryContext,
  );
  const recorded = async function* () {
    let output = "";
    for await (const chunk of source) {
      output += chunk.text;
      yield chunk;
    }
    if (output.trim()) {
      await recordGeneration(request, requestId, messages, output);
    } else {
      logger.warn(
        { ...retryContext, retryExpected: true },
        "The AI provider stream closed without usable content, so no assistant result or training record can be produced. The caller will surface a retryable response; inspect provider streaming health if this repeats.",
      );
    }
  };
  return Object.assign(recorded(), {
    requestId,
    model: source.model,
  });
}

function extractJson(text: string, context: AiRetryContext): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const firstObject = trimmed.indexOf("{");
    const lastObject = trimmed.lastIndexOf("}");
    if (firstObject >= 0 && lastObject > firstObject) {
      const parsed = JSON.parse(trimmed.slice(firstObject, lastObject + 1));
      logger.info(
        { ...context, recovery: "extract_json_object" },
        "The AI response included wrapper text around a valid JSON object; automatic extraction succeeded and processing continues normally. No action is needed unless this recovery becomes frequent.",
      );
      return parsed;
    }
    const firstArray = trimmed.indexOf("[");
    const lastArray = trimmed.lastIndexOf("]");
    if (firstArray >= 0 && lastArray > firstArray) {
      const parsed = JSON.parse(trimmed.slice(firstArray, lastArray + 1));
      logger.info(
        { ...context, recovery: "extract_json_array" },
        "The AI response included wrapper text around a valid JSON array; automatic extraction succeeded and processing continues normally. No action is needed unless this recovery becomes frequent.",
      );
      return parsed;
    }
    throw new AiValidationError("The AI returned malformed JSON.");
  }
}

export async function generateAiJson<T>(request: AiTextRequest, schema: ZodType<T>): Promise<AiTextResult & { data: T }> {
  const provider = getAiProvider();
  const requestId = randomUUID();
  const messages = buildMessages(request);
  const retryContext = {
    requestId,
    taskType: request.taskType,
    provider: provider.name,
    model: provider.model,
    experimentId: request.experimentId,
    projectId: request.projectId,
  };
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
    const result = await withRetry(
      () => provider.generate(providerRequest(request, requestId, attemptMessages, true)),
      retryContext,
    );
    lastText = result.text;
    let validationFailure = "schema_mismatch";
    let validationIssueCount: number | undefined;
    try {
      const parsed = schema.safeParse(extractJson(lastText, retryContext));
      if (parsed.success) {
        await recordGeneration(request, requestId, messages, JSON.stringify(parsed.data));
        return { text: JSON.stringify(parsed.data), data: parsed.data, requestId, model: result.model };
      }
      validationIssueCount = parsed.error.issues.length;
      validationMessage = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    } catch (error) {
      validationFailure = "malformed_json";
      validationMessage = error instanceof Error ? error.message : "malformed JSON";
    }
    if (validationAttempt === 0) {
      logger.warn(
        {
          ...retryContext,
          validationAttempt: validationAttempt + 1,
          maxValidationAttempts: 2,
          validationFailure,
          validationIssueCount,
          retryExpected: true,
        },
        "The AI provider returned structured output that could not be validated; no invalid data was stored, and one automatic correction attempt will run. If the correction also fails, inspect model compatibility with the requested schema using the AI request ID.",
      );
    }
  }
  throw new AiValidationError(`The AI could not produce valid structured output: ${validationMessage}`);
}

export function aiErrorStatus(error: unknown): number {
  if (error instanceof AiProviderError || error instanceof AiValidationError) return error.statusCode;
  return 500;
}
