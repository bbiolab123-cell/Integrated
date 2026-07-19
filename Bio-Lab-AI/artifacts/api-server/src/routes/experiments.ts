import { Router, type IRouter, type Response } from "express";
import { eq, desc, sql, like, and, or, isNull } from "drizzle-orm";
import { db, experiments, conversations, messages, experimentTemplates, recommendationActions, experimentComments, tasks } from "@workspace/db";
import {
  CreateExperimentBody,
  UpdateExperimentBody,
  ListExperimentsQueryParams,
  AnalyzeExperimentBody,
} from "@workspace/api-zod";
import { z } from "zod";
import {
  aiErrorStatus,
  buildExperimentContext,
  buildRelatedExperimentContext,
  generateAiJson,
  normalizeControlSummary,
  numericAuditNotice,
  streamAiText,
  type AiCallContext,
} from "../lib/ai";
import { analysisKnowledgeBlock, assayGuidanceBlock } from "../lib/assayKnowledge";
import { PROTOCOL_JSON_FORMAT, parseStructuredProtocol, type StructuredProtocol } from "../lib/protocol";
import { getRequestUserId } from "../lib/requestUser";
import { aiDailyQuota, aiRateLimiter } from "../middlewares/rateLimit";
import { assertMaxChars } from "../lib/requestLimits";
import ExcelJS from "exceljs";
import mammoth from "mammoth";

const router: IRouter = Router();
const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;
const MAX_UPLOAD_BASE64_CHARS = Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 16;
const MAX_WORKBOOK_ROWS = 512;
const MAX_WORKBOOK_COLUMNS = 64;
const MAX_TEXT_ROWS = 5_000;
const MAX_TEXT_COLUMNS = 128;
const MAX_CELL_CHARS = 500;
const MAX_CONDITION_GROUPS = 100;
const WELL_ID_RE = /^[A-H](?:[1-9]|1[0-2])$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

const StructuredProtocolSchema = z.object({
  objective: z.string(),
  materials: z.array(z.string()),
  controls: z.array(z.string()),
  plate_layout: z.string(),
  steps: z.array(z.string()),
  expected_readout: z.string(),
  suggested_analysis: z.string(),
  review_notes: z.array(z.string()),
  changes_summary: z.array(z.string()),
});

const ExperimentAnalysisSchema = z.object({
  summary: z.string().min(1),
  suggestions: z.array(z.object({
    title: z.string().min(1),
    variable_to_change: z.string().min(1),
    rationale: z.string().min(1),
    expected_outcome: z.string().min(1),
    confidence: z.enum(["low", "medium", "high"]),
  })).length(3),
});

class UploadInputError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
  }
}

function rejectInputError(res: Response, err: unknown): boolean {
  if (err instanceof Error && err.message.includes("Maximum length")) {
    res.status(413).json({ error: err.message });
    return true;
  }
  return false;
}

function writeAiStreamError(res: Response, message = "AI request failed. Please try again."): void {
  if (!res.headersSent) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
  }
  res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
  res.end();
}

function decodeUpload(
  b64: string,
  filename: string,
  opts: { allowedExt?: string[]; typeErrorMessage?: string } = {},
): Buffer {
  if (!filename.trim() || filename.length > 255 || /[\0\r\n/\\]/.test(filename)) {
    throw new UploadInputError("Invalid file name.");
  }
  if (b64.length > MAX_UPLOAD_BASE64_CHARS) {
    throw new UploadInputError(`File too large. Maximum upload size is ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB.`, 413);
  }
  if (!b64.length || b64.length % 4 !== 0 || !BASE64_RE.test(b64)) {
    throw new UploadInputError("Invalid file encoding.");
  }
  const buffer = Buffer.from(b64, "base64");
  if (!buffer.byteLength) {
    throw new UploadInputError("The uploaded file is empty.");
  }
  if (buffer.byteLength > MAX_UPLOAD_BYTES) {
    throw new UploadInputError(`File too large. Maximum upload size is ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB.`, 413);
  }
  const allowedExt = opts.allowedExt ?? ["csv", "tsv", "txt", "xlsx"];
  const ext = filename.split(".").pop()?.toLowerCase();
  if (!ext || !allowedExt.includes(ext)) {
    throw new UploadInputError(opts.typeErrorMessage ?? "Unsupported file type. Upload CSV, TSV, TXT, or XLSX files.");
  }
  const isZipContainer =
    buffer.byteLength >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    ((buffer[2] === 0x03 && buffer[3] === 0x04) ||
      (buffer[2] === 0x05 && buffer[3] === 0x06) ||
      (buffer[2] === 0x07 && buffer[3] === 0x08));
  if ((ext === "xlsx" || ext === "docx") && !isZipContainer) {
    throw new UploadInputError(`The .${ext} file signature is invalid.`);
  }
  if (["csv", "tsv", "txt"].includes(ext) && buffer.includes(0)) {
    throw new UploadInputError("The text upload contains binary data.");
  }
  return buffer;
}

function clampCellString(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > MAX_CELL_CHARS ? trimmed.slice(0, MAX_CELL_CHARS) : trimmed;
}

function excelCellValue(value: ExcelJS.CellValue): unknown {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return clampCellString(value);
  if (typeof value !== "object") return value;
  if ("result" in value) return excelCellValue(value.result as ExcelJS.CellValue);
  if ("text" in value && typeof value.text === "string") return clampCellString(value.text);
  if ("richText" in value && Array.isArray(value.richText)) {
    return clampCellString(value.richText.map((part) => part.text).join(""));
  }
  if ("hyperlink" in value && "text" in value && typeof value.text === "string") return clampCellString(value.text);
  return clampCellString(String(value));
}

async function readFirstWorksheetRows(buffer: Buffer): Promise<unknown[][]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];
  if (sheet.rowCount > MAX_WORKBOOK_ROWS || sheet.columnCount > MAX_WORKBOOK_COLUMNS) {
    throw new UploadInputError(
      `Workbook is too large. Maximum supported sheet size is ${MAX_WORKBOOK_ROWS} rows by ${MAX_WORKBOOK_COLUMNS} columns.`,
      413,
    );
  }

  const rows: unknown[][] = [];
  for (let rowNumber = 1; rowNumber <= sheet.rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    const values: unknown[] = [];
    for (let columnNumber = 1; columnNumber <= sheet.columnCount; columnNumber++) {
      values.push(excelCellValue(row.getCell(columnNumber).value));
    }
    rows.push(values);
  }
  return rows;
}

async function findOwnedExperiment(experimentId: number, userId: string): Promise<typeof experiments.$inferSelect | null> {
  if (!Number.isInteger(experimentId) || experimentId <= 0) return null;
  const [experiment] = await db
    .select()
    .from(experiments)
    .where(and(eq(experiments.id, experimentId), eq(experiments.user_id, userId)))
    .limit(1);
  return experiment ?? null;
}

function requestBody(reqBody: unknown): Record<string, unknown> {
  return reqBody && typeof reqBody === "object" ? reqBody as Record<string, unknown> : {};
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

router.get("/experiments", async (req, res) => {
  try {
    const userId = getRequestUserId(req);
    const query = ListExperimentsQueryParams.parse(req.query);
    const conditions = [eq(experiments.user_id, userId)];
    if (query.assay_type) conditions.push(eq(experiments.assay_type, query.assay_type));
    if (query.status) conditions.push(eq(experiments.status, query.status));
    if (query.search) conditions.push(like(experiments.name, `%${query.search}%`));

    const rows = await db
      .select({
        id: experiments.id,
        name: experiments.name,
        date: experiments.date,
        assay_type: experiments.assay_type,
        instrument: experiments.instrument,
        status: experiments.status,
        created_at: experiments.created_at,
      })
      .from(experiments)
      .where(and(...conditions))
      .orderBy(desc(experiments.created_at));

    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Failed to list experiments");
    res.status(500).json({ error: "Failed to list experiments" });
  }
});

router.get("/experiments/dashboard", async (req, res) => {
  try {
    const userId = getRequestUserId(req);

    const total = await db
      .select({ count: sql<number>`count(*)` })
      .from(experiments)
      .where(eq(experiments.user_id, userId));

    const byStatus = await db
      .select({ status: experiments.status, count: sql<number>`count(*)` })
      .from(experiments)
      .where(eq(experiments.user_id, userId))
      .groupBy(experiments.status);

    const recent = await db
      .select({
        id: experiments.id,
        name: experiments.name,
        date: experiments.date,
        assay_type: experiments.assay_type,
        instrument: experiments.instrument,
        status: experiments.status,
        created_at: experiments.created_at,
      })
      .from(experiments)
      .where(eq(experiments.user_id, userId))
      .orderBy(desc(experiments.created_at))
      .limit(5);

    const byDate = await db
      .select({
        date: sql<string>`date_trunc('day', created_at)::date::text`,
        count: sql<number>`count(*)`,
      })
      .from(experiments)
      .where(eq(experiments.user_id, userId))
      .groupBy(sql`date_trunc('day', created_at)`)
      .orderBy(sql`date_trunc('day', created_at)`)
      .limit(30);

    const byAssay = await db
      .select({ assay_type: experiments.assay_type, count: sql<number>`count(*)` })
      .from(experiments)
      .where(eq(experiments.user_id, userId))
      .groupBy(experiments.assay_type);

    const statusMap: Record<string, number> = {};
    for (const row of byStatus) statusMap[row.status] = Number(row.count);

    res.json({
      total_experiments: Number(total[0]?.count ?? 0),
      by_status: statusMap,
      recent_experiments: recent,
      experiments_by_date: byDate.map((r) => ({ date: r.date, count: Number(r.count) })),
      assay_type_breakdown: byAssay.map((r) => ({ assay_type: r.assay_type, count: Number(r.count) })),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to get dashboard" });
  }
});

router.get("/experiments/:id", async (req, res) => {
  try {
    const userId = getRequestUserId(req);
    const id = parseInt(String(req.params.id), 10);
    const rows = await db.select().from(experiments)
      .where(and(eq(experiments.id, id), eq(experiments.user_id, userId)))
      .limit(1);
    if (!rows[0]) {
      return res.status(404).json({ error: "Experiment not found" });
    }
    return res.json(rows[0]);
  } catch (err) {
    return res.status(500).json({ error: "Failed to get experiment" });
  }
});

router.post("/experiments", async (req, res) => {
  try {
    const userId = getRequestUserId(req);
    const body = CreateExperimentBody.parse(req.body);

    let rawDataJson: string | null = null;
    if (body.file_content_b64 && body.file_name) {
      rawDataJson = await parseFileContent(body.file_content_b64, body.file_name);
    }

    // Create the conversation up front so chat is available from the moment the
    // experiment exists — design-time discussion shouldn't be gated behind running
    // an analysis (which previously created it lazily inside /analyze). Wrapped in
    // a transaction so a failed experiment insert can't leave an orphaned
    // conversation row behind.
    const inserted = await db.transaction(async (tx) => {
      const [conv] = await tx
        .insert(conversations)
        .values({ title: `Copilot: ${body.name}`, user_id: userId })
        .returning();

      return tx
        .insert(experiments)
        .values({
          user_id: userId,
          name: body.name,
          date: body.date,
          assay_type: body.assay_type,
          instrument: body.instrument ?? "Generic",
          notes: body.notes ?? null,
          status: body.status ?? "designing",
          file_name: body.file_name ?? null,
          raw_data_json: rawDataJson,
          conversation_id: conv.id,
        })
        .returning();
    });

    return res.status(201).json(inserted[0]);
  } catch (err) {
    req.log.error({ err }, "Failed to create experiment");
    if (err instanceof UploadInputError) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    return res.status(400).json({ error: "Failed to create experiment" });
  }
});

router.put("/experiments/:id", async (req, res) => {
  try {
    const userId = getRequestUserId(req);
    const id = parseInt(String(req.params.id), 10);
    const body = UpdateExperimentBody.parse(req.body);

    const updated = await db
      .update(experiments)
      .set({ ...body, updated_at: new Date() })
      .where(and(eq(experiments.id, id), eq(experiments.user_id, userId)))
      .returning();

    if (!updated[0]) {
      return res.status(404).json({ error: "Experiment not found" });
    }
    return res.json(updated[0]);
  } catch (err) {
    req.log.error({ err }, "Failed to update experiment");
    return res.status(400).json({ error: "Failed to update experiment" });
  }
});

router.delete("/experiments/:id", async (req, res) => {
  try {
    const userId = getRequestUserId(req);
    const id = parseInt(req.params.id);
    const deleted = await db.delete(experiments)
      .where(and(eq(experiments.id, id), eq(experiments.user_id, userId)))
      .returning();
    if (!deleted[0]) {
      return res.status(404).json({ error: "Experiment not found" });
    }
    return res.status(204).send();
  } catch (err) {
    return res.status(500).json({ error: "Failed to delete experiment" });
  }
});

// Attach (or replace) plate data on an EXISTING experiment. This is what makes the
// design-first workflow possible: create an experiment from a goal/protocol with no
// data, then upload the plate output later and quantify it. Re-parses the file and
// clears the previous AI analysis (it no longer matches the new data).
router.post("/experiments/:id/data", async (req, res) => {
  try {
    const userId = getRequestUserId(req);
    const id = parseInt(String(req.params.id), 10);
    const body = requestBody(req.body);
    const fileContentB64 = optionalString(body.file_content_b64);
    const fileName = optionalString(body.file_name);
    if (!fileContentB64 || !fileName) {
      return res.status(400).json({ error: "file_content_b64 and file_name are required" });
    }

    const exp = await findOwnedExperiment(id, userId);
    if (!exp) return res.status(404).json({ error: "Experiment not found" });

    const rawDataJson = await parseFileContent(fileContentB64, fileName);
    // Guard against degenerate parses so we never overwrite good analysis with junk:
    // parseFileContent returns { error } for empty/too-short files, or a plate96 with
    // zero readings when no 8×12 grid was found. Reject both rather than attaching them.
    try {
      const parsed = JSON.parse(rawDataJson) as { _type?: string; error?: string; stats?: { well_count?: number } };
      if (parsed.error) {
        return res.status(422).json({
          error: "Couldn't read any data from this file. Upload a Gen5 / Synergy H1 .xlsx plate export, or a CSV/TSV with a header row.",
        });
      }
      if (parsed._type === "plate96" && (parsed.stats?.well_count ?? 0) === 0) {
        return res.status(422).json({
          error: "Couldn't find a 96-well plate grid in this file. Export the plate as a matrix (rows A–H, columns 1–12), or upload a CSV/TSV for other layouts.",
        });
      }
    } catch { /* non-JSON parse result is handled below as-is */ }

    const [updated] = await db
      .update(experiments)
      .set({
        raw_data_json: rawDataJson,
        file_name: fileName,
        control_summary_json: null,
        ai_summary: null,
        ai_summary_request_id: null,
        ai_next_experiments_json: null,
        data_analysis_report: null,
        data_analysis_request_id: null,
        updated_at: new Date(),
      })
      .where(and(eq(experiments.id, id), eq(experiments.user_id, userId)))
      .returning();

    if (!updated) return res.status(404).json({ error: "Experiment not found" });
    return res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Failed to attach data to experiment");
    if (err instanceof UploadInputError) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    return res.status(400).json({ error: "Could not attach data. Upload a valid CSV, TSV, TXT, or XLSX export." });
  }
});

// Shared call: ask the configured provider to produce/refine a structured protocol (with its own
// critique) and parse the result. Used by both the AI-design and .docx-upload
// paths so downstream storage/rendering never needs to know the source.
async function structureProtocolWithAI(
  systemInstruction: string,
  userPrompt: string,
  context: AiCallContext,
): Promise<{ protocol: StructuredProtocol; requestId: string }> {
  const response = await generateAiJson({
    ...context,
    systemInstruction,
    messages: [{ role: "user", content: userPrompt }],
    maxTokens: 4096,
  }, StructuredProtocolSchema);
  if (context.taskType === "sop_structuring") {
    const auditNotice = numericAuditNotice(JSON.stringify(response.data), `${systemInstruction}\n${userPrompt}`);
    if (auditNotice) response.data.review_notes.push(auditNotice);
  }
  return { protocol: response.data, requestId: response.requestId };
}

// Design-time protocol generation/refinement. Synthesizes a structured, bench-ready
// protocol from the experiment's goal/context plus any prior chat discussion (the
// "AI design interview"), grounded in the matched assay's known controls and
// quantification method. Always includes the AI's own critique (review_notes) so
// the scientist sees suggestions rather than a black-box answer. Persists to
// experiments.protocol_json; never changes status — the scientist finalizes manually.
router.post("/experiments/:id/protocol/generate", aiRateLimiter, aiDailyQuota, async (req, res) => {
  try {
    const userId = getRequestUserId(req);
    const id = parseInt(String(req.params.id), 10);
    const exp = await findOwnedExperiment(id, userId);
    if (!exp) return res.status(404).json({ error: "Experiment not found" });

    const body = requestBody(req.body);
    let refineNote = "";
    try {
      refineNote = optionalString(body.refine_note) ? assertMaxChars(String(body.refine_note), "Refinement note") : "";
    } catch (err) {
      if (rejectInputError(res, err)) return;
      throw err;
    }

    const existingProtocol = exp.protocol_json ? parseStructuredProtocol(exp.protocol_json) : null;

    let chatContext = "";
    if (exp.conversation_id) {
      const chatHistory = await db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, exp.conversation_id))
        .orderBy(messages.createdAt);
      if (chatHistory.length > 0) {
        chatContext = `\n\nDESIGN CONVERSATION SO FAR (use this for materials, ranges, constraints the scientist already specified):\n${chatHistory
          .map((m) => `${m.role === "assistant" ? "AI" : "Scientist"}: ${m.content}`)
          .join("\n")}`;
      }
    }

    const assayGuidance = assayGuidanceBlock(`${exp.assay_type} ${exp.notes ?? ""}`);

    const systemInstruction = `You are an expert experimental designer for a cell and molecular biology lab, writing a rigorous, bench-ready SOP. Be as detailed and specific as the science requires: exact concentrations, volumes, timings, seeding densities, replicate counts, the plate/sample layout, and the exact controls needed. This document will be followed step-by-step at the bench, so thoroughness matters more than brevity here.

${assayGuidance}

Always end with "review_notes": a short, honestly critical list of gaps or ambiguities in the protocol you just wrote (e.g. missing a blank well, unspecified replicate count, no stated dose range) — you are reviewing your own work, not praising it. If it's genuinely solid, say so briefly instead of inventing issues.`;

    const userPrompt = existingProtocol
      ? `Refine the existing protocol below based on the scientist's note. Keep everything that still applies; change what the note asks for.

EXISTING PROTOCOL:
${JSON.stringify(existingProtocol, null, 2)}

SCIENTIST'S REFINEMENT NOTE: ${refineNote || "(none — just re-review and tighten the existing protocol)"}${chatContext}

IMPORTANT: also fill "changes_summary" — a specific, concrete list of what you actually changed vs. the existing protocol above (e.g. "Increased replicate count from 2 to 3 per dose", "Added a vehicle-only column as blank control"). If you changed nothing, say so explicitly rather than leaving it empty.

Respond in this exact JSON format:
${PROTOCOL_JSON_FORMAT}`
      : `Design a protocol for this experiment.

Name: ${exp.name}
Goal / assay type: ${exp.assay_type}
Context from the scientist: ${exp.notes ?? "(none provided — infer reasonable defaults and note assumptions in review_notes)"}${chatContext}

Respond in this exact JSON format:
${PROTOCOL_JSON_FORMAT}`;

    const { protocol, requestId } = await structureProtocolWithAI(systemInstruction, userPrompt, {
      taskType: "protocol_generation",
      userId,
      experimentId: id,
      sensitiveTerms: [exp.name, ...(exp.file_name ? [exp.file_name] : [])],
    });

    // changes_summary is a one-time diff for THIS refinement, not a durable
    // protocol property — strip it before persisting so it doesn't get compared
    // against as "EXISTING PROTOCOL" on the next refine. Still returned below so
    // the frontend can show it once, right after this call.
    const { changes_summary, ...protocolToPersist } = protocol;
    await db
      .update(experiments)
      .set({ protocol_json: JSON.stringify(protocolToPersist), protocol_ai_request_id: requestId, updated_at: new Date() })
      .where(and(eq(experiments.id, id), eq(experiments.user_id, userId)));

    return res.json({ ...protocol, ai_request_id: requestId });
  } catch (err) {
    req.log.error({ err }, "Failed to generate protocol");
    return res.status(aiErrorStatus(err)).json({ error: "Failed to generate protocol" });
  }
});

// Upload an existing SOP as a .docx (scientists write these in Word/Drive, not
// retyped into a form). Extracts the raw text, then runs it through the SAME
// structuring pipeline as AI-design so the result renders identically regardless
// of source — plus the AI's critique, same as the design path.
router.post("/experiments/:id/protocol/upload", aiRateLimiter, aiDailyQuota, async (req, res) => {
  try {
    const userId = getRequestUserId(req);
    const id = parseInt(String(req.params.id), 10);
    const exp = await findOwnedExperiment(id, userId);
    if (!exp) return res.status(404).json({ error: "Experiment not found" });

    const body = requestBody(req.body);
    const fileContentB64 = optionalString(body.file_content_b64);
    const fileName = optionalString(body.file_name);
    if (!fileContentB64 || !fileName) {
      return res.status(400).json({ error: "file_content_b64 and file_name are required" });
    }

    const buffer = decodeUpload(fileContentB64, fileName, {
      allowedExt: ["docx"],
      typeErrorMessage: "Unsupported file type. Upload your SOP as a Word (.docx) document.",
    });

    const { value: sopText } = await mammoth.extractRawText({ buffer });
    if (!sopText.trim()) {
      return res.status(422).json({ error: "Couldn't read any text from this document. Make sure it isn't empty or a scanned image." });
    }

    const assayGuidance = assayGuidanceBlock(`${exp.assay_type} ${exp.notes ?? ""}`);
    const systemInstruction = `You are an expert experimental designer reviewing a scientist's existing SOP for a cell and molecular biology lab. Reorganize it into the structured format below WITHOUT inventing details it doesn't contain — preserve the original concentrations, timings, and steps exactly. Only fill a field from your own knowledge if the source document truly omits it, and note that assumption in review_notes.

${assayGuidance}

Always end with "review_notes": a short, honestly critical list of gaps or ambiguities in THIS uploaded protocol (e.g. missing a blank well, unspecified replicate count) — you are reviewing it, not rewriting it from scratch.`;

    const userPrompt = `Structure this uploaded SOP for "${exp.name}" (${exp.assay_type}):

--- UPLOADED DOCUMENT TEXT ---
${sopText.slice(0, 20000)}
--- END DOCUMENT ---

Respond in this exact JSON format:
${PROTOCOL_JSON_FORMAT}`;

    const { protocol, requestId } = await structureProtocolWithAI(systemInstruction, userPrompt, {
      taskType: "sop_structuring",
      userId,
      experimentId: id,
      sensitiveTerms: [exp.name, fileName, ...(exp.file_name ? [exp.file_name] : [])],
    });

    // Note: experiments.file_name is reserved for the plate-data upload (set by
    // POST /:id/data) — deliberately not overwritten here to avoid the two
    // uploads clobbering each other's filename.
    await db
      .update(experiments)
      .set({ protocol_json: JSON.stringify(protocol), protocol_ai_request_id: requestId, updated_at: new Date() })
      .where(and(eq(experiments.id, id), eq(experiments.user_id, userId)));

    return res.json({ ...protocol, ai_request_id: requestId });
  } catch (err) {
    req.log.error({ err }, "Failed to parse uploaded SOP");
    if (err instanceof UploadInputError) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    const aiStatus = aiErrorStatus(err);
    if (aiStatus !== 500) {
      return res.status(aiStatus).json({ error: err instanceof Error ? err.message : "AI request failed." });
    }
    return res.status(400).json({ error: "Could not read this document. Upload a valid .docx file." });
  }
});

router.post("/experiments/:id/data-analysis", aiRateLimiter, aiDailyQuota, async (req, res) => {
  try {
    const userId = getRequestUserId(req);
    const id = parseInt(String(req.params.id), 10);
    const rows = await db.select().from(experiments)
      .where(and(eq(experiments.id, id), eq(experiments.user_id, userId)))
      .limit(1);
    if (!rows[0]) return res.status(404).json({ error: "Experiment not found" });
    const exp = rows[0];

    const body = requestBody(req.body);
    let notes = "";
    let quantifyRequest = "";
    let refineNote = "";
    try {
      notes = optionalString(body.notes) ? assertMaxChars(String(body.notes), "Notes") : "";
      quantifyRequest = optionalString(body.quantify_request) ? assertMaxChars(String(body.quantify_request), "Quantify request") : "";
      refineNote = optionalString(body.refine_note) ? assertMaxChars(String(body.refine_note), "Refinement note") : "";
    } catch (err) {
      if (rejectInputError(res, err)) return;
      throw err;
    }
    // Mirrors the protocol design pattern: a prior report already existing means
    // this call is a refinement of it, not a fresh first-time analysis.
    const isRefine = !!exp.data_analysis_report;

    const submittedControls = normalizeControlSummary(body.control_summary);
    const effectiveControlJson = submittedControls
      ? JSON.stringify(submittedControls)
      : exp.control_summary_json;
    if (submittedControls) {
      await db.update(experiments)
        .set({ control_summary_json: effectiveControlJson, updated_at: new Date() })
        .where(and(eq(experiments.id, id), eq(experiments.user_id, userId)));
    }

    const related = await db
      .select()
      .from(experiments)
      .where(and(eq(experiments.assay_type, exp.assay_type), eq(experiments.user_id, userId), sql`${experiments.id} != ${id}`))
      .orderBy(desc(experiments.created_at))
      .limit(3);

    const sensitiveTerms = [exp.name, ...related.map((experiment) => experiment.name), ...(exp.file_name ? [exp.file_name] : [])];
    const currentContext = buildExperimentContext(
      { ...exp, control_summary_json: effectiveControlJson },
      { includePreviousReport: isRefine, sensitiveTerms },
    );
    const relatedContext = related.length > 0
      ? buildRelatedExperimentContext(related, sensitiveTerms, { includeData: false })
      : "None";

    const assayGuidance = analysisKnowledgeBlock(`${exp.assay_type} ${exp.notes ?? ""}`);

    const systemPrompt = `You are an expert cell biology and lab data analysis copilot. You specialize in interpreting Synergy H1 / Gen5 microplate reader experiments. You receive:
1) a structured quantitative summary of the current experiment (control stats, dose-response stats, outliers),
2) metadata (assay type, instrument, notes),
3) optionally summaries of previous related experiments.

${assayGuidance}

Your job is to:
- summarize what happened in this experiment,
- interpret the control and replicate quality,
- analyze the dose-response (or other pattern) in quantitative terms,
- identify likely causes of any failures or unexpected patterns,
- compare with previous experiments when relevant,
- and recommend 3 concrete next experiments to run.

Always:
- cite numeric data explicitly from the supplied context,
- mark every newly calculated number as "derived" and state the calculation,
- distinguish between strong evidence and speculation,
- and keep recommendations practical for a small biotech lab.
${notes ? `\nADDITIONAL CONTEXT from the scientist (beyond what's already in the experiment's protocol/notes): ${notes}\n` : ""}${quantifyRequest ? `\nWHAT THE SCIENTIST SPECIFICALLY WANTS QUANTIFIED: ${quantifyRequest}. Make this the centerpiece of section 3 (Dose-Response or Pattern Analysis) — compute exactly this using the correct method for the assay, not a generic summary.\n` : ""}
Respond in structured markdown with these exact sections:
## 1. Summary of Experiment
## 2. Data Quality & Controls
## 3. Dose-Response or Pattern Analysis
## 4. Likely Causes for Observed Outcomes
## 5. Comparison to Previous Experiments
## 6. Recommended Next 3 Experiments
## 7. Confidence and Limitations${isRefine ? "\n## 8. What Changed From the Previous Report" : ""}`;

    const userPrompt = isRefine
      ? `Refine the existing provider report using the scientist's note and re-check every claim against the complete context.

SCIENTIST'S REFINEMENT NOTE: ${refineNote || "(none — re-review and tighten the previous report against the data)"}

COMPLETE EXPERIMENT CONTEXT (including the previous report when it was generated by this provider):
${currentContext}

Produce the FULL updated report, ending with section 8 summarizing what changed. If nothing substantive changed, say so.`
      : `Analyze this experiment and produce the structured report.

COMPLETE EXPERIMENT CONTEXT:
${currentContext}

RELATED EXPERIMENTS (same assay type, metadata only):
${relatedContext}`;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const stream = await streamAiText({
      taskType: "data_analysis",
      userId,
      experimentId: id,
      systemInstruction: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
      maxTokens: 6144,
      sensitiveTerms,
    });

    let streamed = "";
    for await (const chunk of stream) {
      const text = chunk.text;
      if (text) {
        streamed += text;
        res.write(`data: ${JSON.stringify({ content: text })}\n\n`);
      }
    }

    if (streamed.trim()) {
      const auditNotice = numericAuditNotice(streamed, `${systemPrompt}\n${userPrompt}`);
      if (auditNotice) {
        const warning = `\n\n> **Numeric verification notice:** ${auditNotice}`;
        streamed += warning;
        res.write(`data: ${JSON.stringify({ content: warning, warning: auditNotice })}\n\n`);
      }
      // Persist so the report survives a refresh, can be refined next time, and
      // can ground follow-up chat questions.
      await db
        .update(experiments)
        .set({ data_analysis_report: streamed, data_analysis_request_id: stream.requestId, updated_at: new Date() })
        .where(and(eq(experiments.id, id), eq(experiments.user_id, userId)));
      res.write(`data: ${JSON.stringify({ done: true, request_id: stream.requestId })}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify({ error: "The AI returned an empty report (it may be rate-limited). Please try again." })}\n\n`);
    }
    return res.end();
  } catch (err) {
    req.log.error({ err }, "Failed to generate data analysis report");
    writeAiStreamError(res);
    return;
  }
});

interface QuantifyChartSpec {
  type: "column_means" | "row_means" | "well_scatter" | "dose_response";
  title: string;
  // Only meaningful for type "dose_response" — extracted from the scientist's
  // OWN question (e.g. "column 1, top conc 100uM, 3-fold serial dilution").
  // Never guessed from data the AI hasn't been told.
  dose_response_config?: {
    orientation: "row" | "column";
    index: string;
    top_concentration: number;
    unit: string;
    dilution_factor: number;
    reverse: boolean;
  };
}

function parseQuantifyResponse(text: string): { answer: string; chart: QuantifyChartSpec | null } {
  try {
    const parsed = JSON.parse(text) as { answer?: unknown; chart?: unknown };
    const answer = typeof parsed.answer === "string" ? parsed.answer : "";
    let chart: QuantifyChartSpec | null = null;
    if (parsed.chart && typeof parsed.chart === "object") {
      const c = parsed.chart as Record<string, unknown>;
      const validTypes = ["column_means", "row_means", "well_scatter", "dose_response"];
      if (typeof c.type === "string" && validTypes.includes(c.type)) {
        chart = { type: c.type as QuantifyChartSpec["type"], title: typeof c.title === "string" ? c.title : "Chart" };
        if (chart.type === "dose_response" && c.dose_response_config && typeof c.dose_response_config === "object") {
          const dc = c.dose_response_config as Record<string, unknown>;
          const orientation = dc.orientation === "row" || dc.orientation === "column" ? dc.orientation : null;
          const topConc = typeof dc.top_concentration === "number" && dc.top_concentration > 0 ? dc.top_concentration : null;
          // A dose-response chart needs real config extracted from the question —
          // if it's incomplete, drop the chart entirely rather than guess at it.
          if (orientation && topConc) {
            chart.dose_response_config = {
              orientation,
              index: typeof dc.index === "string" ? dc.index : (orientation === "column" ? "1" : "A"),
              top_concentration: topConc,
              unit: typeof dc.unit === "string" ? dc.unit : "µM",
              dilution_factor: typeof dc.dilution_factor === "number" && dc.dilution_factor > 1 ? dc.dilution_factor : 3,
              reverse: dc.reverse === true,
            };
          } else {
            chart = null;
          }
        }
      }
    }
    return { answer, chart };
  } catch {
    return { answer: text, chart: null };
  }
}

// Focused Q&A for the Data Analysis "Quantify anything" box. Unlike the
// streaming /gemini/conversations chat, this returns structured JSON so the
// frontend can render a REAL chart when one is warranted — but the AI only
// ever picks the chart TYPE and (for dose-response) config explicitly stated
// in the scientist's own question; it never invents data points. The actual
// numbers are always computed deterministically client-side from the real
// plate data. Persists into the same conversation as the streaming chat, so
// both surfaces show one continuous history.
router.post("/experiments/:id/quantify", aiRateLimiter, async (req, res) => {
  try {
    const userId = getRequestUserId(req);
    const id = parseInt(String(req.params.id), 10);
    const exp = await findOwnedExperiment(id, userId);
    if (!exp) return res.status(404).json({ error: "Experiment not found" });

    const body = requestBody(req.body);
    let question: string;
    try {
      question = optionalString(body.question) ? assertMaxChars(String(body.question), "Question") : "";
    } catch (err) {
      if (rejectInputError(res, err)) return;
      throw err;
    }
    if (!question) return res.status(400).json({ error: "A question is required" });

    // Every experiment gets a conversation at creation time now, but older
    // experiments predating that change may still have none — create one
    // lazily here rather than assume it always exists.
    let convId = exp.conversation_id;
    if (!convId) {
      const conv = await db.insert(conversations).values({ title: `Copilot: ${exp.name}`, user_id: userId }).returning();
      convId = conv[0].id;
      await db.update(experiments).set({ conversation_id: convId, updated_at: new Date() })
        .where(and(eq(experiments.id, id), eq(experiments.user_id, userId)));
    }

    let plateSummary: Record<string, unknown> | null = null;
    if (exp.raw_data_json) {
      try { plateSummary = JSON.parse(exp.raw_data_json); } catch {}
    }
    const plateSummaryText = plateSummary
      ? JSON.stringify(plateSummary, null, 2).substring(0, 4000)
      : "No plate data uploaded yet for this experiment.";

    const assayGuidance = analysisKnowledgeBlock(`${exp.assay_type} ${exp.notes ?? ""}`);

    const systemInstruction = `You are a lab data copilot answering a focused, specific question about one experiment's plate data — not writing a full report, just answering directly like a colleague would.

${assayGuidance}

Answer with real numbers from the data provided, citing specific wells/values. Be concise — a few sentences, not a report.

If (and only if) a chart would genuinely help answer this question, also propose one, but you must NEVER invent the actual data — you only pick WHICH chart and, for dose-response, extract its configuration strictly from what the scientist explicitly stated in their question:
- "column_means" / "row_means": mean signal per plate column/row — use when the question is about spatial patterns, edge effects, or uniformity.
- "well_scatter": every well's raw value — use for a general distribution/outlier view.
- "dose_response": a 4PL dose-response curve — use ONLY when the question is about potency/IC50/EC50 AND the scientist's question states (or the experiment notes already state) which column or row is the dose series, the top concentration, and the dilution factor. If any of these is missing or ambiguous, do NOT propose this chart — instead, in your answer, ask the scientist to specify orientation/column-or-row/top concentration/dilution factor.
If no chart is warranted or you don't have enough information, set "chart" to null.

Respond in this exact JSON format:
{
  "answer": "your direct answer, a few sentences, with real numbers",
  "chart": null | {
    "type": "column_means" | "row_means" | "well_scatter" | "dose_response",
    "title": "short chart title",
    "dose_response_config": null | { "orientation": "row" | "column", "index": "1", "top_concentration": 100, "unit": "µM", "dilution_factor": 3, "reverse": false }
  }
}`;

    const userPrompt = `Experiment: ${exp.name} (${exp.assay_type}, ${exp.instrument})
Notes: ${exp.notes ?? "None"}

Plate data summary:
\`\`\`json
${plateSummaryText}
\`\`\`

Scientist's question: ${question}`;

    await db.insert(messages).values({ conversationId: convId, role: "user", content: question });

    const response = await generateContentWithRetry({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      config: {
        systemInstruction,
        maxOutputTokens: 4096,
        responseMimeType: "application/json",
        thinkingConfig: { thinkingBudget: 0 },
      },
    });

    const { answer, chart } = parseQuantifyResponse(response.text ?? "{}");
    if (!answer.trim()) {
      return res.status(502).json({ error: "The AI returned an empty answer. Please try again." });
    }

    await db.insert(messages).values({ conversationId: convId, role: "assistant", content: answer });

    return res.json({ answer, chart, conversation_id: convId });
  } catch (err) {
    req.log.error({ err }, "Failed to answer quantify question");
    return res.status(500).json({ error: "Failed to answer quantify question" });
  }
});

router.get("/templates", async (req, res) => {
  const userId = getRequestUserId(req);
  const rows = await db
    .select()
    .from(experimentTemplates)
    .where(or(isNull(experimentTemplates.user_id), eq(experimentTemplates.user_id, userId)))
    .orderBy(desc(experimentTemplates.created_at));
  res.json(rows);
});

router.get("/templates/:id", async (req, res) => {
  const userId = getRequestUserId(req);
  const id = parseInt(req.params.id);
  const rows = await db.select().from(experimentTemplates).where(eq(experimentTemplates.id, id)).limit(1);
  if (!rows[0]) return res.status(404).json({ error: "Template not found" });
  if (rows[0].user_id && rows[0].user_id !== userId) return res.status(404).json({ error: "Template not found" });
  return res.json(rows[0]);
});

router.post("/templates", async (req, res) => {
  try {
    const userId = getRequestUserId(req);
    const body = requestBody(req.body);
    const name = optionalString(body.name);
    const assayType = optionalString(body.assay_type);
    if (!name || !assayType) {
      return res.status(400).json({ error: "name and assay_type are required" });
    }
    const row = await db.insert(experimentTemplates).values({
      user_id: userId,
      name,
      assay_type: assayType,
      instrument: optionalString(body.instrument) ?? "Synergy H1",
      description: optionalString(body.description),
      default_notes: optionalString(body.default_notes),
      expected_columns_json: optionalString(body.expected_columns_json),
      expected_control_rule: optionalString(body.expected_control_rule),
      expected_status_default: optionalString(body.expected_status_default) ?? "in_progress",
      ai_prompt_hint: optionalString(body.ai_prompt_hint),
    }).returning();
    return res.status(201).json(row[0]);
  } catch (err) {
    req.log.error({ err }, "Failed to create template");
    return res.status(400).json({ error: "Failed to create template" });
  }
});

router.put("/templates/:id", async (req, res) => {
  const userId = getRequestUserId(req);
  const id = parseInt(req.params.id);
  const body = requestBody(req.body);
  const patch: Partial<typeof experimentTemplates.$inferInsert> = { updated_at: new Date() };
  if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
  if (typeof body.assay_type === "string" && body.assay_type.trim()) patch.assay_type = body.assay_type.trim();
  if (typeof body.instrument === "string" && body.instrument.trim()) patch.instrument = body.instrument.trim();
  if (typeof body.description === "string") patch.description = body.description.trim() || null;
  if (typeof body.default_notes === "string") patch.default_notes = body.default_notes.trim() || null;
  if (typeof body.expected_columns_json === "string") patch.expected_columns_json = body.expected_columns_json.trim() || null;
  if (typeof body.expected_control_rule === "string") patch.expected_control_rule = body.expected_control_rule.trim() || null;
  if (typeof body.expected_status_default === "string" && body.expected_status_default.trim()) patch.expected_status_default = body.expected_status_default.trim();
  if (typeof body.ai_prompt_hint === "string") patch.ai_prompt_hint = body.ai_prompt_hint.trim() || null;
  const row = await db.update(experimentTemplates).set(patch).where(and(eq(experimentTemplates.id, id), eq(experimentTemplates.user_id, userId))).returning();
  if (!row[0]) return res.status(404).json({ error: "Template not found" });
  return res.json(row[0]);
});

router.delete("/templates/:id", async (req, res) => {
  const userId = getRequestUserId(req);
  const id = parseInt(req.params.id);
  const row = await db.delete(experimentTemplates).where(and(eq(experimentTemplates.id, id), eq(experimentTemplates.user_id, userId))).returning();
  if (!row[0]) return res.status(404).json({ error: "Template not found" });
  return res.status(204).send();
});

router.get("/experiments/:id/recommendations/actions", async (req, res) => {
  const userId = getRequestUserId(req);
  const experimentId = parseInt(req.params.id);
  const exp = await findOwnedExperiment(experimentId, userId);
  if (!exp) return res.status(404).json({ error: "Experiment not found" });
  const rows = await db.select().from(recommendationActions).where(eq(recommendationActions.experiment_id, experimentId)).orderBy(desc(recommendationActions.updated_at));
  return res.json(rows);
});

router.post("/experiments/:id/recommendations/:index/approve", async (req, res) => {
  const userId = getRequestUserId(req);
  const experimentId = parseInt(req.params.id);
  const recommendationIndex = parseInt(req.params.index);
  const exp = await findOwnedExperiment(experimentId, userId);
  if (!exp) return res.status(404).json({ error: "Experiment not found" });
  const suggestions = exp.ai_next_experiments_json ? JSON.parse(exp.ai_next_experiments_json) : [];
  const original = suggestions[recommendationIndex];
  if (!original) return res.status(404).json({ error: "Recommendation not found" });
  const body = requestBody(req.body);
  const [row] = await db.insert(recommendationActions).values({
    experiment_id: experimentId,
    recommendation_index: recommendationIndex,
    recommendation_title: original.title ?? "Recommendation",
    original_recommendation_json: JSON.stringify(original),
    action_status: "approved",
    reviewer_name: optionalString(body.reviewer_name),
    reviewer_note: optionalString(body.reviewer_note),
  }).returning();
  return res.json(row);
});

router.post("/experiments/:id/recommendations/:index/reject", async (req, res) => {
  const userId = getRequestUserId(req);
  const experimentId = parseInt(req.params.id);
  const recommendationIndex = parseInt(req.params.index);
  const exp = await findOwnedExperiment(experimentId, userId);
  if (!exp) return res.status(404).json({ error: "Experiment not found" });
  const body = requestBody(req.body);
  const [row] = await db.insert(recommendationActions).values({
    experiment_id: experimentId,
    recommendation_index: recommendationIndex,
    recommendation_title: optionalString(body.title) ?? "Recommendation",
    original_recommendation_json: JSON.stringify(body.original ?? {}),
    action_status: "rejected",
    reviewer_name: optionalString(body.reviewer_name),
    reviewer_note: optionalString(body.reviewer_note),
  }).returning();
  return res.json(row);
});

router.post("/experiments/:id/recommendations/:index/edit", async (req, res) => {
  const userId = getRequestUserId(req);
  const experimentId = parseInt(req.params.id);
  const recommendationIndex = parseInt(req.params.index);
  const exp = await findOwnedExperiment(experimentId, userId);
  if (!exp) return res.status(404).json({ error: "Experiment not found" });
  const body = requestBody(req.body);
  const row = await db.insert(recommendationActions).values({
    experiment_id: experimentId,
    recommendation_index: recommendationIndex,
    recommendation_title: optionalString(body.title) ?? "Recommendation",
    original_recommendation_json: JSON.stringify(body.original ?? {}),
    edited_recommendation_json: JSON.stringify({
      title: optionalString(body.title),
      variable_to_change: optionalString(body.variable_to_change),
      rationale: optionalString(body.rationale),
      expected_outcome: optionalString(body.expected_outcome),
      confidence: optionalString(body.confidence),
    }),
    action_status: "edited",
    reviewer_name: optionalString(body.reviewer_name),
    reviewer_note: optionalString(body.reviewer_note),
  }).returning();
  return res.json(row[0]);
});

router.get("/experiments/:id/comments", async (req, res) => {
  const userId = getRequestUserId(req);
  const experimentId = parseInt(req.params.id);
  const exp = await findOwnedExperiment(experimentId, userId);
  if (!exp) return res.status(404).json({ error: "Experiment not found" });
  const rows = await db.select().from(experimentComments)
    .where(and(eq(experimentComments.experiment_id, experimentId), eq(experimentComments.user_id, userId)))
    .orderBy(desc(experimentComments.created_at));
  return res.json(rows);
});

router.post("/experiments/:id/comments", async (req, res) => {
  const userId = getRequestUserId(req);
  const experimentId = parseInt(req.params.id);
  const exp = await findOwnedExperiment(experimentId, userId);
  if (!exp) return res.status(404).json({ error: "Experiment not found" });
  const body = requestBody(req.body);
  const content = optionalString(body.content);
  const authorName = optionalString(body.author_name);
  if (!content || !authorName) return res.status(400).json({ error: "author_name and content are required" });
  const row = await db.insert(experimentComments).values({
    user_id: userId,
    experiment_id: experimentId,
    comment_type: optionalString(body.comment_type) ?? "note",
    target_reference: optionalString(body.target_reference),
    author_name: authorName,
    content,
  }).returning();
  return res.status(201).json(row[0]);
});

router.delete("/comments/:comment_id", async (req, res) => {
  const userId = getRequestUserId(req);
  const id = parseInt(req.params.comment_id);
  const row = await db.delete(experimentComments)
    .where(and(eq(experimentComments.id, id), eq(experimentComments.user_id, userId)))
    .returning();
  if (!row[0]) return res.status(404).json({ error: "Comment not found" });
  return res.status(204).send();
});

router.get("/tasks", async (req, res) => {
  const userId = getRequestUserId(req);
  const rows = await db.select().from(tasks).where(eq(tasks.user_id, userId)).orderBy(desc(tasks.created_at));
  return res.json(rows);
});

router.get("/experiments/:id/tasks", async (req, res) => {
  const userId = getRequestUserId(req);
  const experimentId = parseInt(req.params.id);
  const exp = await findOwnedExperiment(experimentId, userId);
  if (!exp) return res.status(404).json({ error: "Experiment not found" });
  const rows = await db.select().from(tasks)
    .where(and(eq(tasks.experiment_id, experimentId), eq(tasks.user_id, userId)))
    .orderBy(desc(tasks.created_at));
  return res.json(rows);
});

router.post("/tasks", async (req, res) => {
  const userId = getRequestUserId(req);
  const body = requestBody(req.body);
  const experimentId = Number(body.experiment_id);
  if (!Number.isInteger(experimentId)) return res.status(400).json({ error: "experiment_id is required" });
  const exp = await findOwnedExperiment(experimentId, userId);
  if (!exp) return res.status(404).json({ error: "Experiment not found" });
  const title = optionalString(body.title);
  if (!title) return res.status(400).json({ error: "title is required" });
  const row = await db.insert(tasks).values({
    user_id: userId,
    experiment_id: experimentId,
    source_recommendation_index: typeof body.source_recommendation_index === "number" ? body.source_recommendation_index : null,
    title,
    description: optionalString(body.description),
    owner_name: optionalString(body.owner_name),
    due_date: optionalString(body.due_date),
    status: optionalString(body.status) ?? "todo",
    priority: optionalString(body.priority) ?? "medium",
  }).returning();
  return res.status(201).json(row[0]);
});

router.put("/tasks/:id", async (req, res) => {
  const userId = getRequestUserId(req);
  const id = parseInt(req.params.id);
  const body = requestBody(req.body);
  const patch: Record<string, unknown> = { updated_at: new Date() };
  if (typeof body.experiment_id !== "undefined") {
    const experimentId = Number(body.experiment_id);
    if (!Number.isInteger(experimentId)) return res.status(400).json({ error: "experiment_id must be a number" });
    const exp = await findOwnedExperiment(experimentId, userId);
    if (!exp) return res.status(404).json({ error: "Experiment not found" });
    patch.experiment_id = experimentId;
  }
  if (typeof body.source_recommendation_index === "number") patch.source_recommendation_index = body.source_recommendation_index;
  if (typeof body.title === "string" && body.title.trim()) patch.title = body.title.trim();
  if (typeof body.description === "string") patch.description = body.description.trim() || null;
  if (typeof body.owner_name === "string") patch.owner_name = body.owner_name.trim() || null;
  if (typeof body.due_date === "string") patch.due_date = body.due_date.trim() || null;
  if (typeof body.status === "string" && body.status.trim()) patch.status = body.status.trim();
  if (typeof body.priority === "string" && body.priority.trim()) patch.priority = body.priority.trim();

  const row = await db.update(tasks).set(patch)
    .where(and(eq(tasks.id, id), eq(tasks.user_id, userId)))
    .returning();
  if (!row[0]) return res.status(404).json({ error: "Task not found" });
  return res.json(row[0]);
});

router.delete("/tasks/:id", async (req, res) => {
  const userId = getRequestUserId(req);
  const id = parseInt(req.params.id);
  const row = await db.delete(tasks).where(and(eq(tasks.id, id), eq(tasks.user_id, userId))).returning();
  if (!row[0]) return res.status(404).json({ error: "Task not found" });
  return res.status(204).send();
});

router.post("/experiments/:id/analyze", aiRateLimiter, aiDailyQuota, async (req, res) => {
  try {
    const userId = getRequestUserId(req);
    const id = parseInt(String(req.params.id), 10);
    const bodyParsed = req.body && Object.keys(req.body).length > 0
      ? AnalyzeExperimentBody.parse(req.body)
      : {};

    const rows = await db.select().from(experiments)
      .where(and(eq(experiments.id, id), eq(experiments.user_id, userId)))
      .limit(1);
    if (!rows[0]) return res.status(404).json({ error: "Experiment not found" });
    const exp = rows[0];

    // Fetch related experiments for context
    const related = await db
      .select()
      .from(experiments)
      .where(and(eq(experiments.assay_type, exp.assay_type), eq(experiments.user_id, userId), sql`${experiments.id} != ${id}`))
      .orderBy(desc(experiments.created_at))
      .limit(3);

    let focusQuestion = "";
    try {
      focusQuestion = bodyParsed.focus_question ? assertMaxChars(bodyParsed.focus_question, "Focus question") : "";
    } catch (err) {
      if (rejectInputError(res, err)) return;
      throw err;
    }
    const focusNote = focusQuestion ? `\nFocus question: ${focusQuestion}` : "";

    // The client sends the scientist's plate layout (marked control wells) so the
    // AI quantifies off the real plate map instead of guessing which wells are controls.
    const cs = (req.body && typeof req.body === "object")
      ? (req.body as Record<string, unknown>).control_summary as Record<string, unknown> | undefined
      : undefined;
    const normalizedControls = normalizeControlSummary(cs) ?? normalizeControlSummary(
      exp.control_summary_json ? (() => { try { return JSON.parse(exp.control_summary_json); } catch { return null; } })() : null,
    );
    const effectiveControlJson = normalizedControls ? JSON.stringify(normalizedControls) : exp.control_summary_json;
    if (normalizedControls && cs) {
      await db.update(experiments)
        .set({ control_summary_json: effectiveControlJson, updated_at: new Date() })
        .where(and(eq(experiments.id, id), eq(experiments.user_id, userId)));
    }

    const sensitiveTerms = [exp.name, ...related.map((experiment) => experiment.name), ...(exp.file_name ? [exp.file_name] : [])];
    const experimentContext = buildExperimentContext(
      { ...exp, control_summary_json: effectiveControlJson },
      { sensitiveTerms },
    );
    const relatedContext = related.length > 0
      ? buildRelatedExperimentContext(related, sensitiveTerms, { includeData: false })
      : "No related experiments found.";

    const isPlateReaderExp = (exp.instrument?.toLowerCase().includes("synergy") ||
      exp.assay_type?.toLowerCase().includes("plate reader") ||
      exp.assay_type?.toLowerCase().includes("elisa") ||
      exp.assay_type?.toLowerCase().includes("absorbance") ||
      (exp.raw_data_json?.includes('"_type":"plate96"') ?? false));

    const assayGuidance = analysisKnowledgeBlock(`${exp.assay_type} ${exp.notes ?? ""}`);

    const systemPrompt = isPlateReaderExp
      ? `You are a senior assay scientist reviewing a colleague's plate-reader run. Think like a bench scientist, not a report generator: first work out what this experiment was TRYING to do from its protocol/notes, state the result you would EXPECT if it worked, then judge what the data actually shows and explain WHY — distinguishing a technical problem from a real biological finding.

${assayGuidance}

Your analysis MUST cover, in this order:
1. Intent & expectation — in 1–2 sentences, restate what the experiment set out to test (from the protocol/notes) and the result you'd expect if it succeeded.
2. Quantitative readout — compute the assay-appropriate metric using the method above, with numbers and specific well IDs/values. Label every number not directly present in the context as "derived" and state the calculation. State the assumptions you made (dose axis, which wells are controls).
3. Plate QC — replicate CV%, outlier wells (cite IDs + values), signal-to-background, edge effects (peripheral vs inner wells), and the Z'-factor if positive/negative controls are identifiable (Z' ≥ 0.5 excellent, 0–0.5 marginal, < 0 fail).
4. Verdict — do the results match the expectation? If YES, confirm and give your confidence. If NO, diagnose the most likely cause and rank possibilities: technical (edge-well evaporation, high CV, vehicle toxicity, missing blank subtraction, saturated/floored signal, dead controls) vs biological (compound inactive, dose range wrong, weak effect). Be concrete about which wells/numbers led you there.

Write the summary as clean markdown with short bold section headers. Lead with the headline number(s) and the verdict.`
      : `You are a senior lab scientist reviewing a colleague's experiment. Think like a bench scientist: infer the experiment's intent from the protocol/notes, state the expected result, then judge what the data shows and explain why. Be specific and quantitative — compute the assay-appropriate readout (e.g. ΔΔCt fold-change for qPCR, concentration from a standard curve, band ratios for blots), lead with hard numbers citing the data, give a clear verdict (expected vs not, with a ranked diagnosis if not), and state your assumptions.`;

    const userPrompt = `Review this experiment like a scientist: understand its intent from the protocol/notes, state what you'd expect, quantify what actually happened, and give a verdict with diagnosis. Then propose exactly 3 next experiments.

COMPLETE EXPERIMENT CONTEXT (full plate, deterministic controls, protocol, notes, and metadata):
${experimentContext}

RELATED EXPERIMENTS (metadata only):
${relatedContext}${focusNote}

Respond in this exact JSON format:
{
  "summary": "...",
  "suggestions": [
    {
      "title": "...",
      "variable_to_change": "...",
      "rationale": "...",
      "expected_outcome": "...",
      "confidence": "low|medium|high"
    }
  ]
}`;

    const response = await generateAiJson({
      taskType: "experiment_analysis",
      userId,
      experimentId: id,
      systemInstruction: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
      maxTokens: 4096,
      sensitiveTerms,
    }, ExperimentAnalysisSchema);
    const parsed = response.data;
    const auditNotice = numericAuditNotice(parsed.summary, `${systemPrompt}\n${userPrompt}`);
    if (auditNotice) parsed.summary += `\n\n> **Numeric verification notice:** ${auditNotice}`;

    // Create a conversation for this experiment if it doesn't have one
    let convId = exp.conversation_id;
    if (!convId) {
      const conv = await db
        .insert(conversations)
        .values({ title: `Copilot: ${exp.name}`, user_id: userId })
        .returning();
      convId = conv[0].id;
      await db
        .update(experiments)
        .set({ conversation_id: convId, updated_at: new Date() })
        .where(and(eq(experiments.id, id), eq(experiments.user_id, userId)));
    }

    // Save AI summary and suggestions
    await db
      .update(experiments)
      .set({
        ai_summary: parsed.summary,
        ai_summary_request_id: response.requestId,
        ai_next_experiments_json: JSON.stringify(parsed.suggestions),
        updated_at: new Date(),
      })
      .where(and(eq(experiments.id, id), eq(experiments.user_id, userId)));

    // Save as assistant message in conversation
    await db.insert(messages).values({
      conversationId: convId,
      role: "assistant",
      content: `**Analysis Summary**\n\n${parsed.summary}`,
      aiRequestId: response.requestId,
    });

    return res.json({
      ai_summary: parsed.summary,
      suggestions: parsed.suggestions,
      conversation_id: convId,
      request_id: response.requestId,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to analyze experiment");
    return res.status(aiErrorStatus(err)).json({ error: "Failed to analyze experiment" });
  }
});

router.post("/experiments/compare", aiRateLimiter, aiDailyQuota, async (req, res) => {
  try {
    const userId = getRequestUserId(req);
    const { experiment_a_id, experiment_b_id, question } = req.body as {
      experiment_a_id: number;
      experiment_b_id: number;
      question?: string;
    };
    let safeQuestion: string | undefined;
    try {
      safeQuestion = question ? assertMaxChars(question, "Comparison question") : undefined;
    } catch (err) {
      if (rejectInputError(res, err)) return;
      throw err;
    }

    if (!experiment_a_id || !experiment_b_id) {
      return res.status(400).json({ error: "Both experiment_a_id and experiment_b_id are required" });
    }

    const [rowsA, rowsB] = await Promise.all([
      db.select().from(experiments).where(and(eq(experiments.id, experiment_a_id), eq(experiments.user_id, userId))).limit(1),
      db.select().from(experiments).where(and(eq(experiments.id, experiment_b_id), eq(experiments.user_id, userId))).limit(1),
    ]);

    if (!rowsA[0]) return res.status(404).json({ error: "Experiment A not found" });
    if (!rowsB[0]) return res.status(404).json({ error: "Experiment B not found" });

    const a = rowsA[0];
    const b = rowsB[0];

    const sensitiveTerms = [a.name, b.name, ...(a.file_name ? [a.file_name] : []), ...(b.file_name ? [b.file_name] : [])];
    const formatExp = (experiment: typeof a, label: string) =>
      `=== ${label} ===\n${buildExperimentContext(experiment, { sensitiveTerms })}`;

    const userPrompt = safeQuestion
      ? `The scientist asks: "${safeQuestion}"\n\nPlease answer using the two experiments below as context.\n\n${formatExp(a, "Experiment A")}\n\n${formatExp(b, "Experiment B")}`
      : `Compare these two experiments in detail. Cover:\n1. What was different between them (conditions, protocol, timing)\n2. Why one succeeded / failed vs the other\n3. Key lessons learned from the comparison\n4. Concrete recommendations for the next experiment based on both runs\n\n${formatExp(a, "Experiment A")}\n\n${formatExp(b, "Experiment B")}`;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const comparisonSystemPrompt = `You are an expert lab scientist specializing in comparative experiment analysis. Identify root causes of success or failure from differences between runs. Cite only numbers present in the supplied contexts; mark calculations as derived. Give actionable conclusions.`;
    const stream = await streamAiText({
      taskType: "experiment_comparison",
      userId,
      systemInstruction: comparisonSystemPrompt,
      messages: [{ role: "user", content: userPrompt }],
      maxTokens: 4096,
      sensitiveTerms,
    });

    let streamed = "";
    for await (const chunk of stream) {
      const text = chunk.text;
      if (text) {
        streamed += text;
        res.write(`data: ${JSON.stringify({ content: text })}\n\n`);
      }
    }

    if (streamed.trim()) {
      const auditNotice = numericAuditNotice(streamed, `${comparisonSystemPrompt}\n${userPrompt}`);
      if (auditNotice) {
        const warning = `\n\n> **Numeric verification notice:** ${auditNotice}`;
        res.write(`data: ${JSON.stringify({ content: warning, warning: auditNotice })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ done: true, request_id: stream.requestId })}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify({ error: "The AI returned an empty comparison (it may be rate-limited). Please try again." })}\n\n`);
    }
    return res.end();
  } catch (err) {
    req.log.error({ err }, "Failed to compare experiments");
    writeAiStreamError(res);
    return;
  }
});

router.post("/experiments/parse-synergy", async (req, res) => {
  try {
    const { file_content_b64, file_name } = req.body as {
      file_content_b64: string;
      file_name: string;
    };

    if (!file_content_b64 || !file_name) {
      return res.status(400).json({ error: "file_content_b64 and file_name are required" });
    }

    const buffer = decodeUpload(file_content_b64, file_name);
    const rows = await readFirstWorksheetRows(buffer);
    if (!rows.length) {
      return res.status(422).json({ error: "This spreadsheet is empty. Upload a Gen5 / Synergy H1 plate export with data." });
    }

    const result = parseSynergyH1Rows(rows, file_name);
    // A valid parse still yields zero readings when the sheet has no detectable
    // 8×12 grid (wrong export, transposed layout, or a non-plate sheet). Tell the
    // user instead of returning a blank heatmap.
    if (result.stats.well_count === 0) {
      return res.status(422).json({
        error: "Couldn't find a 96-well plate grid in this file. Export the plate as a matrix (rows A–H, columns 1–12) from Gen5, or use the CSV/TSV upload for other layouts.",
      });
    }
    return res.json(result);
  } catch (err) {
    req.log.error({ err }, "Failed to parse Synergy H1 file");
    if (err instanceof UploadInputError) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    return res.status(400).json({ error: "Could not parse uploaded file. Please upload a valid CSV, TSV, TXT, or XLSX export." });
  }
});

interface WellData {
  well: string;
  row: string;
  col: number;
  value: number | null;
  status: "ok" | "blank" | "high" | "low";
  cv_pct: number | null;
}

interface PlateParseResult {
  metadata: {
    plate_name: string | null;
    date: string | null;
    protocol: string | null;
    wavelength: string | null;
    instrument: string | null;
    read_type: string | null;
  };
  wells: WellData[];
  stats: {
    mean: number | null;
    sd: number | null;
    cv_pct: number | null;
    min: number | null;
    max: number | null;
    blank_count: number;
    well_count: number;
  };
  read_matrix: (number | null)[][];
}

function parseSynergyH1Rows(rows: unknown[][], filename: string): PlateParseResult {
  const ROWS_ALPHA = ["A", "B", "C", "D", "E", "F", "G", "H"];
  const COLS_NUM = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

  const metadata = {
    plate_name: null as string | null,
    date: null as string | null,
    protocol: null as string | null,
    wavelength: null as string | null,
    instrument: null as string | null,
    read_type: null as string | null,
  };

  const strVal = (v: unknown): string => (v != null ? clampCellString(String(v)) : "");

  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const key = strVal(row[0]).toLowerCase();
    const val = strVal(row[1]);
    if (!val) continue;
    if (key.includes("plate") || key.includes("plate name")) metadata.plate_name = val;
    else if (key.includes("date")) metadata.date = val;
    else if (key.includes("protocol")) metadata.protocol = val;
    else if (key.includes("wavelength") || key.includes("wave length") || key === "read") metadata.wavelength = val;
    else if (key.includes("instrument") || key.includes("reader")) metadata.instrument = val;
    else if (key.includes("read type") || key.includes("assay")) metadata.read_type = val;
  }

  if (!metadata.instrument) metadata.instrument = "Synergy H1";

  let plateStartRow = -1;
  let colOffset = -1;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;
    let consecutiveNums = 0;
    let firstNumIdx = -1;
    for (let j = 0; j < row.length; j++) {
      const v = row[j];
      const n = typeof v === "number" ? v : parseInt(strVal(v), 10);
      if (!isNaN(n) && n >= 1 && n <= 12) {
        if (firstNumIdx === -1) firstNumIdx = j;
        consecutiveNums++;
      } else if (firstNumIdx !== -1) {
        break;
      }
    }
    if (consecutiveNums >= 8) {
      plateStartRow = i + 1;
      colOffset = firstNumIdx;
      break;
    }
  }

  if (plateStartRow === -1) {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!Array.isArray(row)) continue;
      const firstCell = strVal(row[0]).toUpperCase();
      if (firstCell === "A") {
        let hasNumbers = false;
        for (let j = 1; j < Math.min(row.length, 14); j++) {
          const v = row[j];
          const n = typeof v === "number" ? v : parseFloat(strVal(v));
          if (!isNaN(n)) { hasNumbers = true; break; }
        }
        if (hasNumbers) {
          plateStartRow = i;
          colOffset = 1;
          break;
        }
      }
    }
  }

  const readMatrix: (number | null)[][] = Array.from({ length: 8 }, () =>
    Array(12).fill(null)
  );

  if (plateStartRow !== -1) {
    for (let r = 0; r < 8; r++) {
      const rowIdx = plateStartRow + r;
      if (rowIdx >= rows.length) break;
      const row = rows[rowIdx];
      if (!Array.isArray(row)) continue;
      const rowLabel = strVal(row[0]).toUpperCase();
      const rowAlphaIdx = ROWS_ALPHA.indexOf(rowLabel);
      const targetRow = rowAlphaIdx >= 0 ? rowAlphaIdx : r;

      for (let c = 0; c < 12; c++) {
        const cellIdx = colOffset + c;
        if (cellIdx >= row.length) continue;
        const raw = row[cellIdx];
        const n = typeof raw === "number" ? raw : parseFloat(strVal(raw));
        if (!isNaN(n)) readMatrix[targetRow][c] = n;
      }
    }
  }

  const allValues = readMatrix.flat().filter((v): v is number => v !== null);
  let mean: number | null = null;
  let sd: number | null = null;
  let cv_pct: number | null = null;
  let min: number | null = null;
  let max: number | null = null;

  if (allValues.length > 0) {
    mean = allValues.reduce((a, b) => a + b, 0) / allValues.length;
    sd = Math.sqrt(allValues.reduce((a, b) => a + (b - mean!) ** 2, 0) / allValues.length);
    cv_pct = mean !== 0 ? (sd / mean) * 100 : null;
    min = Math.min(...allValues);
    max = Math.max(...allValues);
  }

  const blankThreshold = min !== null && max !== null ? min + (max - min) * 0.05 : 0;
  const highThreshold = max !== null && mean !== null ? mean + 2 * (sd ?? 0) : Infinity;
  const lowThreshold = mean !== null ? mean - 2 * (sd ?? 0) : -Infinity;

  const wells: WellData[] = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 12; c++) {
      const val = readMatrix[r][c];
      const wellId = `${ROWS_ALPHA[r]}${COLS_NUM[c]}`;
      let status: WellData["status"] = "ok";
      if (val === null || val <= blankThreshold) status = "blank";
      else if (val > highThreshold) status = "high";
      else if (val < lowThreshold) status = "low";

      wells.push({
        well: wellId,
        row: ROWS_ALPHA[r],
        col: COLS_NUM[c],
        value: val,
        status,
        cv_pct: null,
      });
    }
  }

  return {
    metadata,
    wells,
    stats: {
      mean: mean !== null ? parseFloat(mean.toFixed(4)) : null,
      sd: sd !== null ? parseFloat(sd.toFixed(4)) : null,
      cv_pct: cv_pct !== null ? parseFloat(cv_pct.toFixed(2)) : null,
      min: min !== null ? parseFloat(min.toFixed(4)) : null,
      max: max !== null ? parseFloat(max.toFixed(4)) : null,
      blank_count: wells.filter((w) => w.status === "blank").length,
      well_count: allValues.length,
    },
    read_matrix: readMatrix,
  };
}

async function parseFileContent(b64: string, filename: string): Promise<string> {
  try {
    const ext = filename.split(".").pop()?.toLowerCase();
    const buffer = decodeUpload(b64, filename);
    if (ext === "xlsx") {
      const rows = await readFirstWorksheetRows(buffer);
      if (!rows.length) return JSON.stringify({ error: "No rows found", filename });
      const result = parseSynergyH1Rows(rows, filename);
      return JSON.stringify({ ...result, _type: "plate96" });
    }

    const content = buffer.toString("utf-8");
    const lines = content.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length > MAX_TEXT_ROWS + 1) {
      throw new UploadInputError(`Text file has too many rows. Maximum supported row count is ${MAX_TEXT_ROWS}.`, 413);
    }
    if (lines.length < 2) return JSON.stringify({ error: "File too short", rows: 0 });

    const delimiter = ext === "tsv" ? "\t" : ",";
    const headerCells = lines[0].split(delimiter);
    if (headerCells.length > MAX_TEXT_COLUMNS) {
      throw new UploadInputError(`Text file has too many columns. Maximum supported column count is ${MAX_TEXT_COLUMNS}.`, 413);
    }
    const headers = headerCells.map((h) => clampCellString(h.replace(/"/g, "")));
    const rows = lines.slice(1).map((line) => {
      const vals = line.split(delimiter).slice(0, headers.length).map((v) => clampCellString(v.replace(/"/g, "")));
      return Object.fromEntries(headers.map((h, i) => [h, vals[i] ?? ""]));
    });

    const signalKey = headers.find((h) => /signal|value|od|abs|rlu|rfu|rcu/i.test(h));
    const conditionKey = headers.find((h) => /condition|group|treatment/i.test(h));

    const summary: Record<string, unknown> = {
      filename,
      total_rows: rows.length,
      columns: headers,
    };

    if (signalKey) {
      const signals = rows.map((r) => parseFloat(r[signalKey] ?? "0")).filter((n) => !isNaN(n));
      if (signals.length > 0) {
        const mean = signals.reduce((a, b) => a + b, 0) / signals.length;
        const sd = Math.sqrt(signals.reduce((a, b) => a + (b - mean) ** 2, 0) / signals.length);
        summary.signal_stats = { mean: mean.toFixed(4), sd: sd.toFixed(4), n: signals.length };
      }
    }

    if (conditionKey) {
      const groups: Record<string, number[]> = {};
      for (const row of rows) {
        const cond = clampCellString(row[conditionKey] ?? "Unknown");
        if (!groups[cond] && Object.keys(groups).length >= MAX_CONDITION_GROUPS) continue;
        if (!groups[cond]) groups[cond] = [];
        if (signalKey && !isNaN(parseFloat(row[signalKey] ?? ""))) {
          groups[cond].push(parseFloat(row[signalKey]));
        }
      }
      summary.condition_groups = Object.entries(groups).map(([cond, vals]) => {
        if (!vals.length) return { condition: cond, n: 0, mean: null };
        const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
        return { condition: cond, n: vals.length, mean: mean.toFixed(4) };
      });
    }

    return JSON.stringify(summary);
  } catch (err) {
    if (err instanceof UploadInputError) throw err;
    return JSON.stringify({ error: "Failed to parse file", filename: clampCellString(filename) });
  }
}

export default router;
