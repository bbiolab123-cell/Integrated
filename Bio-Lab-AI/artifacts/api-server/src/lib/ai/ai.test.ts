import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { buildExperimentContext, normalizeControlSummary } from "./context";
import { unsupportedNumericClaims } from "./numericAudit";
import { sanitizeAiText, sanitizeAiValue } from "./sanitize";
import {
  AiProviderError,
  CloudflareAiProvider,
  setAiProviderForTests,
  type AiProvider,
} from "@workspace/integrations-ai";
import { aiDailyQuota } from "../../middlewares/rateLimit";
import type { NextFunction, Request, Response } from "express";

test("sanitizer removes identifiers, secrets, file names, paths, and configured names", () => {
  const text = sanitizeAiText(
    "Project Atlas user_ABC123456 test@example.com Bearer abcdef1234567890 api_token=supersecret report.xlsx /Users/lab/private",
    ["Project Atlas"],
  );
  assert.equal(text.includes("Project Atlas"), false);
  assert.equal(text.includes("test@example.com"), false);
  assert.equal(text.includes("report.xlsx"), false);
  assert.equal(text.includes("supersecret"), false);
  assert.equal(text.includes("/Users/lab/private"), false);
  assert.match(text, /\[redacted-/);

  assert.deepEqual(sanitizeAiValue({ user_id: "secret", email: "x@y.com", api_token: "secret", plate_name: "private", value: 4 }), { value: 4 });
});

test("experiment context preserves all 96 wells, protocol, and persisted controls", () => {
  const wells = Array.from({ length: 96 }, (_, index) => {
    const row = String.fromCharCode(65 + Math.floor(index / 12));
    const col = index % 12 + 1;
    return { well: `${row}${col}`, row, col, value: index + 0.25, status: "ok", cv_pct: null };
  });
  const context = buildExperimentContext({
    id: 7,
    user_id: "user_private",
    name: "Secret experiment",
    date: "2026-07-18",
    assay_type: "Viability",
    instrument: "Synergy H1",
    notes: "dose response",
    status: "running",
    protocol_json: JSON.stringify({ objective: "test", materials: [], controls: ["vehicle"], plate_layout: "96 well", steps: [], expected_readout: "signal", suggested_analysis: "4PL", review_notes: [], changes_summary: [] }),
    file_name: "secret.xlsx",
    raw_data_json: JSON.stringify({ _type: "plate96", stats: { well_count: 96 }, wells, read_matrix: [] }),
    control_summary_json: JSON.stringify({ positive_control_wells: ["A1"], negative_control_wells: ["H12"] }),
    ai_summary: null,
    ai_summary_request_id: null,
    ai_next_experiments_json: null,
    data_analysis_report: null,
    data_analysis_request_id: null,
    protocol_ai_request_id: null,
    conversation_id: null,
    project_id: null,
    created_at: new Date(),
    updated_at: new Date(),
  }, { sensitiveTerms: ["Secret experiment", "secret.xlsx"] });

  const parsed = JSON.parse(context);
  assert.equal(parsed.quantitative_data.wells.length, 96);
  assert.deepEqual(parsed.quantitative_data.well_fields, ["well", "value", "status", "cv_pct"]);
  assert.equal(parsed.quantitative_data.wells[0][0], "A1");
  assert.equal(parsed.quantitative_data.wells[95][0], "H12");
  assert.equal(parsed.quantitative_data.graph_series.mean_signal_by_plate_column.length, 12);
  assert.equal(parsed.quantitative_data.read_matrix, undefined);
  assert.equal(parsed.protocol.controls[0], "vehicle");
  assert.deepEqual(parsed.control_summary.negative_control_wells, ["H12"]);
  assert.equal(context.includes("user_private"), false);
  assert.equal(context.includes("secret.xlsx"), false);
});

test("control summary accepts only valid wells and finite metrics", () => {
  assert.deepEqual(normalizeControlSummary({
    positive_control_wells: ["a1", "Z9", "H12"],
    negative_control_wells: ["B2"],
    zprime: 0.73,
    mean_positive: Number.NaN,
  }), {
    positive_control_wells: ["A1", "H12"],
    negative_control_wells: ["B2"],
    blank_wells: [],
    sample_wells: [],
    mean_positive: null,
    mean_negative: null,
    zprime: 0.73,
    signal_to_background: null,
  });
});

test("numeric audit flags unsupported claims but permits explicitly derived values", () => {
  assert.deepEqual(unsupportedNumericClaims("The mean was 12.5.", "well A1 was 10.0"), ["12.5"]);
  assert.deepEqual(unsupportedNumericClaims("The derived mean was 12.5.", "well A1 was 10.0"), []);
  assert.deepEqual(unsupportedNumericClaims("Well A1 was 10.0.", "well A1 was 10.0"), []);
});

test("Cloudflare provider translates non-streaming and SSE responses", async () => {
  const originalFetch = globalThis.fetch;
  const env = {
    CLOUDFLARE_ACCOUNT_ID: "account",
    CLOUDFLARE_API_TOKEN: "token",
    CLOUDFLARE_MODEL: "@cf/mistral/mistral-7b-instruct-v0.2-lora",
  } as NodeJS.ProcessEnv;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ success: true, result: { response: "hello" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const provider = new CloudflareAiProvider(env);
    const generated = await provider.generate({ requestId: "req-1", messages: [{ role: "user", content: "hi" }] });
    assert.equal(generated.text, "hello");

    globalThis.fetch = async () => new Response('data: {"response":"hel"}\n\ndata: {"response":"lo"}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
    const stream = await provider.stream({ requestId: "req-2", messages: [{ role: "user", content: "hi" }] });
    let streamed = "";
    for await (const chunk of stream) streamed += chunk.text;
    assert.equal(streamed, "hello");
    assert.equal(stream.requestId, "req-2");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("structured generation retries a transient provider error and repairs invalid JSON once", async () => {
  const previousDatabase = process.env.DATABASE_URL;
  const previousRecording = process.env.AI_RECORD_GENERATIONS;
  process.env.DATABASE_URL = previousDatabase ?? "postgresql://test:test@127.0.0.1:1/test";
  process.env.AI_RECORD_GENERATIONS = "false";
  let calls = 0;
  const provider: AiProvider = {
    name: "test",
    model: "test-model",
    async generate(request) {
      calls += 1;
      if (calls === 1) throw new AiProviderError("retry", 502, true);
      return {
        requestId: request.requestId,
        model: "test-model",
        text: calls === 2 ? '{"value":"invalid"}' : '{"value":7}',
      };
    },
    async stream(request) {
      const chunks = async function* () { yield { text: "unused" }; };
      return Object.assign(chunks(), { requestId: request.requestId, model: "test-model" });
    },
  };
  setAiProviderForTests(provider);
  try {
    const { generateAiJson } = await import("./service");
    const result = await generateAiJson({
      taskType: "experiment_analysis",
      userId: "test-user",
      systemInstruction: "Return JSON.",
      messages: [{ role: "user", content: "Give a value." }],
    }, z.object({ value: z.number() }));
    assert.deepEqual(result.data, { value: 7 });
    assert.equal(calls, 3);
  } finally {
    setAiProviderForTests(null);
    if (previousDatabase === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabase;
    if (previousRecording === undefined) delete process.env.AI_RECORD_GENERATIONS;
    else process.env.AI_RECORD_GENERATIONS = previousRecording;
  }
});

test("daily quota returns a clear limit response without invoking the handler", () => {
  const previousLimit = process.env.AI_DAILY_REQUEST_LIMIT;
  const previousRollout = process.env.AI_ROLLOUT_PERCENT;
  process.env.AI_DAILY_REQUEST_LIMIT = "1";
  process.env.AI_ROLLOUT_PERCENT = "100";
  let nextCalls = 0;
  let statusCode = 200;
  let payload: unknown;
  const headers = new Map<string, string>();
  const response = {
    setHeader(name: string, value: string) {
      headers.set(name, value);
      return this;
    },
    status(value: number) {
      statusCode = value;
      return this;
    },
    json(value: unknown) {
      payload = value;
      return this;
    },
  } as unknown as Response;
  const next = (() => { nextCalls += 1; }) as NextFunction;
  const request = { userId: "quota_test_user" } as unknown as Request;

  try {
    aiDailyQuota(request, response, next);
    assert.equal(nextCalls, 1);
    assert.equal(headers.get("AI-Daily-Remaining"), "0");

    aiDailyQuota(request, response, next);
    assert.equal(nextCalls, 1);
    assert.equal(statusCode, 429);
    assert.match((payload as { error: string }).error, /free daily AI limit/i);
  } finally {
    if (previousLimit === undefined) delete process.env.AI_DAILY_REQUEST_LIMIT;
    else process.env.AI_DAILY_REQUEST_LIMIT = previousLimit;
    if (previousRollout === undefined) delete process.env.AI_ROLLOUT_PERCENT;
    else process.env.AI_ROLLOUT_PERCENT = previousRollout;
  }
});

test("owner-only rollout rejects users outside the configured owner set", () => {
  const previousRollout = process.env.AI_ROLLOUT_PERCENT;
  const previousOwners = process.env.AI_ROLLOUT_OWNER_USER_IDS;
  const previousTrainingAdmins = process.env.AI_TRAINING_ADMIN_USER_IDS;
  process.env.AI_ROLLOUT_PERCENT = "0";
  process.env.AI_ROLLOUT_OWNER_USER_IDS = "owner_user";
  delete process.env.AI_TRAINING_ADMIN_USER_IDS;
  let nextCalls = 0;
  let statusCode = 200;
  let payload: unknown;
  const response = {
    status(value: number) { statusCode = value; return this; },
    json(value: unknown) { payload = value; return this; },
  } as unknown as Response;
  try {
    aiDailyQuota({ userId: "other_user" } as unknown as Request, response, (() => { nextCalls += 1; }) as NextFunction);
    assert.equal(nextCalls, 0);
    assert.equal(statusCode, 503);
    assert.equal((payload as { code: string }).code, "AI_ROLLOUT_UNAVAILABLE");
  } finally {
    if (previousRollout === undefined) delete process.env.AI_ROLLOUT_PERCENT;
    else process.env.AI_ROLLOUT_PERCENT = previousRollout;
    if (previousOwners === undefined) delete process.env.AI_ROLLOUT_OWNER_USER_IDS;
    else process.env.AI_ROLLOUT_OWNER_USER_IDS = previousOwners;
    if (previousTrainingAdmins === undefined) delete process.env.AI_TRAINING_ADMIN_USER_IDS;
    else process.env.AI_TRAINING_ADMIN_USER_IDS = previousTrainingAdmins;
  }
});
