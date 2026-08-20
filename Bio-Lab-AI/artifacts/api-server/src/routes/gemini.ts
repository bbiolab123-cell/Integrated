import { Router, type IRouter, type Response } from "express";
import { eq, desc, and } from "drizzle-orm";
import { db, conversations, messages, experiments, projects, projectDocuments } from "@workspace/db";
import {
  CreateAiConversationBody,
  SendAiMessageBody,
  ListAiConversationsQueryParams,
} from "@workspace/api-zod";
import { z } from "zod";
import {
  aiErrorStatus,
  buildExperimentContext,
  buildRelatedExperimentContext,
  generateAiJson,
  generateAiText,
  numericAuditNotice,
  streamAiText,
} from "../lib/ai";
import { analysisKnowledgeBlock, assayGuidanceBlock } from "../lib/assayKnowledge";
import { parseStructuredProtocol } from "../lib/protocol";
import { synthesizeProject } from "../lib/projectSynthesis";
import { getRequestUserId } from "../lib/requestUser";
import { aiDailyQuota, aiRateLimiter } from "../middlewares/rateLimit";
import { assertMaxChars } from "../lib/requestLimits";

const router: IRouter = Router();

const LAB_SYSTEM_PROMPT = `You are an expert cell biologist and lab copilot with access to this lab's full experiment history.
Think like a bench scientist: when asked about an experiment, reason from its protocol/notes — what was it trying to test, what result was expected, and does the data match? If results are off, diagnose the likely cause (distinguish a technical problem from a real biological finding) and cite the specific wells/numbers. Reference experiments by their supplied experiment_ref. Be specific, quantitative, and actionable.`;

// Chat is a conversation, not a report — the opposite tone from protocol/analysis
// generation, which stays thorough on purpose. Applied to chat prompts only.
const CHAT_TONE_INSTRUCTION = `\n\nTone: this is a live chat, not a report. Talk like a knowledgeable colleague, not a document — short, direct replies (usually 2-5 sentences unless the scientist asks for depth or a list). Don't restate the question, don't pad with preamble, don't over-explain something already established earlier in the conversation. Ask one clarifying question at a time rather than a long list.`;

// Design-stage mode: no protocol exists yet for this experiment. The AI's job here
// is to interview the scientist — gather what a good protocol needs (cell line,
// compound/target, materials on hand, dose range, replicate count, timeline,
// constraints) BEFORE a protocol gets generated — not to write the protocol itself
// (that happens via the dedicated "Generate protocol" action, which reads this
// conversation for context). Keep the interview short and one question at a time.
const PROTOCOL_INTERVIEW_INSTRUCTION = `\n\nThis experiment has no protocol yet — you are in DESIGN mode. Your job right now is to ask focused clarifying questions to gather what's needed for a solid protocol: the specific goal, cell line/model, compound or target, materials/equipment on hand, dose or condition range, replicate count, and any constraints (budget, time, equipment). Ask ONE question at a time, build on what's already been said, and don't write the actual protocol yourself — that happens separately once enough is gathered. If the scientist says they're ready or asks you to just generate it, tell them to use the "Generate protocol" action so it can produce the full structured document.`;

// Running-stage mode: a protocol is finalized. Ground troubleshooting in what the
// protocol actually says, and help track progress against it conversationally.
function runningStageInstruction(protocol: { objective: string; materials: string[]; controls: string[]; steps: string[] } | null): string {
  if (!protocol) return "";
  const steps = protocol.steps.length ? protocol.steps.map((s, i) => `${i + 1}. ${s}`).join("\n") : "(none listed)";
  return `\n\nTHIS EXPERIMENT'S FINALIZED PROTOCOL:
Objective: ${protocol.objective || "(not stated)"}
Materials: ${protocol.materials.join("; ") || "(none listed)"}
Controls: ${protocol.controls.join("; ") || "(none listed)"}
Steps:
${steps}

You are now in RUN/TROUBLESHOOT mode. The scientist may report progress ("we finished step 2", "step 3 looked off") or ask troubleshooting questions — ground your answers in the actual steps/materials/controls above, and when something looks wrong, distinguish a technical issue (pipetting, timing, reagent) from a real biological finding, citing the specific step.`;
}

const GENERAL_SYSTEM_PROMPT = `You are an expert biotech and cell biology advisor with access to the scientist's own experiment history.
Answer general scientific questions, explain concepts, help with protocol design, and discuss biotech topics. Be concise and scientific.
When their logged experiments are relevant, reason from those rather than from generic textbook knowledge, and be explicit about which you are using.`;

// How much of the scientist's history to ground each answer in. Capped on both
// row count and characters: this runs on every dashboard question, and the
// provider bills per token.
const GENERAL_CHAT_HISTORY_LIMIT = 12;
const GENERAL_CHAT_HISTORY_BUDGET = 24_000;
// Prior turns accepted from the client, so a follow-up like "why?" still works.
// Bounded because the client controls this array.
const GENERAL_CHAT_MAX_TURNS = 8;

const PROJECT_SYSTEM_PROMPT = `You are an expert cell biologist and research strategist acting as the copilot for an entire research PROJECT.
You are given the project's goal and every experiment logged under it. Reason across the whole project, not one plate:
connect findings between experiments, flag patterns, contradictions, and gaps, and recommend concrete next experiments
that advance the project's goal. Reference experiments by their supplied experiment_ref. Be specific, quantitative, and actionable.`;

const StandaloneProtocolSchema = z.object({
  title: z.string().min(1),
  assay_type: z.string().min(1),
  instrument: z.string().min(1),
  objective: z.string().min(1),
  materials: z.array(z.string()).min(1),
  controls: z.array(z.string()).min(1),
  plate_layout: z.string().min(1),
  steps: z.array(z.string()).min(1),
  expected_readout: z.string().min(1),
  suggested_analysis: z.string().min(1),
});

type ConversationRow = typeof conversations.$inferSelect;
type ExperimentRow = typeof experiments.$inferSelect;

const SEARCH_STOP_WORDS = new Set(["about", "after", "again", "could", "experiment", "from", "have", "into", "project", "that", "their", "there", "these", "this", "what", "when", "where", "which", "with", "would"]);

function searchTerms(value: string): Set<string> {
  return new Set(
    value.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g)
      ?.filter((term) => !SEARCH_STOP_WORDS.has(term)) ?? [],
  );
}

function selectRelevantProjectExperiments(rows: ExperimentRow[], query: string, limit = 3): ExperimentRow[] {
  const terms = searchTerms(query);
  if (!terms.size) return rows.slice(0, limit);
  const scored = rows.map((row, index) => {
    const name = row.name.toLowerCase();
    const searchable = `${row.name} ${row.assay_type} ${row.instrument} ${row.status} ${row.notes ?? ""}`.toLowerCase();
    let score = 0;
    for (const term of terms) if (searchable.includes(term)) score += name.includes(term) ? 3 : 1;
    return { row, index, score };
  });
  const matches = scored.filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
  return (matches.length ? matches : scored).slice(0, limit).map((entry) => entry.row);
}

function buildLabHistory(experimentRows: ExperimentRow[], metadataOnly = false): string {
  return buildRelatedExperimentContext(
    experimentRows,
    experimentRows.map((experiment) => experiment.name),
    { metadataOnly },
  );
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

router.get(["/ai/conversations", "/gemini/conversations"], async (req, res) => {
  try {
    const userId = getRequestUserId(req);
    const query = ListAiConversationsQueryParams.parse(req.query);
    let rows: ConversationRow[] = [];
    if (query.experiment_id) {
      const exp = await db
        .select({ conversation_id: experiments.conversation_id })
        .from(experiments)
        .where(and(eq(experiments.id, query.experiment_id), eq(experiments.user_id, userId)))
        .limit(1);
      if (exp[0]?.conversation_id) {
        rows = await db
          .select()
          .from(conversations)
          .where(and(eq(conversations.id, exp[0].conversation_id), eq(conversations.user_id, userId)))
          .orderBy(desc(conversations.createdAt));
      }
    } else {
      rows = await db
        .select()
        .from(conversations)
        .where(eq(conversations.user_id, userId))
        .orderBy(desc(conversations.createdAt));
    }

    const expRows = await db
      .select({ id: experiments.id, conversation_id: experiments.conversation_id })
      .from(experiments)
      .where(eq(experiments.user_id, userId));
    const convToExpMap: Record<number, number> = {};
    for (const e of expRows) {
      if (e.conversation_id) convToExpMap[e.conversation_id] = e.id;
    }

    res.json(rows.map((c) => ({ ...c, experimentId: convToExpMap[c.id] ?? null })));
  } catch (err) {
    req.log.error({ err }, "Failed to list AI conversations");
    res.status(500).json({ error: "Failed to list conversations" });
  }
});

router.post(["/ai/conversations", "/gemini/conversations"], async (req, res) => {
  try {
    const body = CreateAiConversationBody.parse(req.body);
    const userId = getRequestUserId(req);
    if (body.experimentId) {
      const ownedExperiment = await db
        .select({ id: experiments.id })
        .from(experiments)
        .where(and(eq(experiments.id, body.experimentId), eq(experiments.user_id, userId)))
        .limit(1);
      if (!ownedExperiment[0]) {
        res.status(404).json({ error: "Experiment not found" });
        return;
      }
    }

    const inserted = await db.insert(conversations).values({ title: body.title, user_id: userId }).returning();
    const conv = inserted[0];
    if (!conv) {
      res.status(500).json({ error: "Failed to create conversation" });
      return;
    }

    if (body.experimentId) {
      await db
        .update(experiments)
        .set({ conversation_id: conv.id, updated_at: new Date() })
        .where(and(eq(experiments.id, body.experimentId), eq(experiments.user_id, userId)));
    }

    const expRows = await db
      .select({ id: experiments.id })
      .from(experiments)
      .where(and(eq(experiments.conversation_id, conv.id), eq(experiments.user_id, userId)))
      .limit(1);

    res.status(201).json({ ...conv, experimentId: expRows[0]?.id ?? body.experimentId ?? null });
  } catch (err) {
    req.log.error({ err }, "Failed to create AI conversation");
    res.status(400).json({ error: "Failed to create conversation" });
  }
});

router.get(["/ai/conversations/:id", "/gemini/conversations/:id"], async (req, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const userId = getRequestUserId(req);
    const rows = await db.select().from(conversations).where(and(eq(conversations.id, id), eq(conversations.user_id, userId))).limit(1);
    if (!rows[0]) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }

    const msgs = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, id))
      .orderBy(messages.createdAt);

    const expRows = await db
      .select({ id: experiments.id })
      .from(experiments)
      .where(and(eq(experiments.conversation_id, id), eq(experiments.user_id, userId)))
      .limit(1);

    res.json({ ...rows[0], experimentId: expRows[0]?.id ?? null, messages: msgs });
  } catch (err) {
    req.log.error({ err }, "Failed to get AI conversation");
    res.status(500).json({ error: "Failed to get conversation" });
  }
});

router.delete(["/ai/conversations/:id", "/gemini/conversations/:id"], async (req, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const userId = getRequestUserId(req);
    const deleted = await db.delete(conversations).where(and(eq(conversations.id, id), eq(conversations.user_id, userId))).returning();
    if (!deleted[0]) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.status(204).send();
  } catch (err) {
    req.log.error({ err }, "Failed to delete AI conversation");
    res.status(500).json({ error: "Failed to delete conversation" });
  }
});

router.get(["/ai/conversations/:id/messages", "/gemini/conversations/:id/messages"], async (req, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const userId = getRequestUserId(req);
    const owner = await db
      .select({ user_id: conversations.user_id })
      .from(conversations)
      .where(and(eq(conversations.id, id), eq(conversations.user_id, userId)))
      .limit(1);
    if (!owner[0]) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    const msgs = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, id))
      .orderBy(messages.createdAt);
    res.json(msgs);
  } catch (err) {
    req.log.error({ err }, "Failed to list AI messages");
    res.status(500).json({ error: "Failed to list messages" });
  }
});

router.post(["/ai/conversations/:id/messages", "/gemini/conversations/:id/messages"], aiRateLimiter, aiDailyQuota, async (req, res) => {
  try {
    const convId = parseInt(String(req.params.id), 10);
    const userId = getRequestUserId(req);
    const body = SendAiMessageBody.parse(req.body);
    let content: string;
    try {
      content = assertMaxChars(body.content, "Message");
    } catch (err) {
      if (rejectInputError(res, err)) return;
      throw err;
    }

    const conv = await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, convId), eq(conversations.user_id, userId)))
      .limit(1);
    if (!conv[0]) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }

    await db
      .insert(messages)
      .values({ conversationId: convId, role: "user", content });

    const expRows = await db
      .select()
      .from(experiments)
      .where(and(eq(experiments.conversation_id, convId), eq(experiments.user_id, userId)))
      .limit(1);
    const exp = expRows[0];

    const chatHistory = (await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, convId))
      .orderBy(desc(messages.createdAt))
      .limit(40))
      .reverse()
      // Never feed legacy Gemini assistant text into this provider or an
      // eventual training record. User messages remain valid context.
      .filter((message) => message.role !== "assistant" || message.aiRequestId)
      .slice(-20);

    const allExperiments = await db
      .select()
      .from(experiments)
      .where(eq(experiments.user_id, userId))
      .orderBy(desc(experiments.date))
      .limit(20);

    const protocol = exp?.protocol_json ? parseStructuredProtocol(exp.protocol_json) : null;

    let systemInstruction = LAB_SYSTEM_PROMPT;
    if (exp) {
      // Before a protocol exists, ground in just the assay's domain knowledge (what
      // to ask about) — the full data-quantification checklist isn't relevant yet
      // and would distract from the interview. Once a protocol is finalized, use
      // the full knowledge block plus the protocol content itself.
      systemInstruction += protocol
        ? `\n\n${analysisKnowledgeBlock(`${exp.assay_type} ${exp.notes ?? ""}`)}${runningStageInstruction(protocol)}`
        : `\n\n${assayGuidanceBlock(`${exp.assay_type} ${exp.notes ?? ""}`)}${PROTOCOL_INTERVIEW_INSTRUCTION}`;
    }
    systemInstruction += CHAT_TONE_INSTRUCTION;
    const sensitiveTerms = [
      ...allExperiments.map((experiment) => experiment.name),
      ...(exp?.file_name ? [exp.file_name] : []),
    ];
    systemInstruction += `\n\nRECENT LAB HISTORY (metadata only):\n${buildLabHistory(allExperiments, true)}\n\nCURRENT EXPERIMENT WITH COMPLETE QUANTITATIVE DATA, CONTROLS, AND PROTOCOL:\n${exp
      ? buildExperimentContext(exp, { includePreviousReport: true, sensitiveTerms })
      : "None"}`;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    let fullResponse = "";

    const stream = await streamAiText({
      taskType: "experiment_chat",
      userId,
      experimentId: exp?.id,
      systemInstruction,
      messages: chatHistory.map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.content,
      })),
      maxTokens: 4096,
      sensitiveTerms,
    });

    for await (const chunk of stream) {
      const text = chunk.text;
      if (text) {
        fullResponse += text;
        res.write(`data: ${JSON.stringify({ content: text })}\n\n`);
      }
    }

    if (fullResponse.trim()) {
      const auditNotice = exp
        ? numericAuditNotice(fullResponse, `${systemInstruction}\n${chatHistory.map((message) => message.content).join("\n")}`)
        : null;
      if (auditNotice) {
        const warning = `\n\n> **Numeric verification notice:** ${auditNotice}`;
        fullResponse += warning;
        res.write(`data: ${JSON.stringify({ content: warning, warning: auditNotice })}\n\n`);
      }
      await db
        .insert(messages)
        .values({ conversationId: convId, role: "assistant", content: fullResponse, aiRequestId: stream.requestId });
      res.write(`data: ${JSON.stringify({ done: true, request_id: stream.requestId })}\n\n`);
    } else {
      // Don't persist an empty assistant bubble — surface a retryable error instead.
      res.write(
        `data: ${JSON.stringify({
          error: "The AI returned an empty response (it may be rate-limited). Please try again.",
        })}\n\n`,
      );
    }
    res.end();
  } catch (err) {
    req.log.error({ err }, "Failed to send AI message");
    writeAiStreamError(res, aiErrorStatus(err) === 429 ? "The free daily AI limit has been reached." : undefined);
  }
});

// ── Project copilot (Phase 2) ─────────────────────────────────────────────────
// A chat scoped to one Project: grounded in the project's goal + ONLY that
// project's experiments. The project's conversation is created lazily on first
// message (projects.conversation_id).

router.get("/projects/:id/messages", async (req, res) => {
  try {
    const userId = getRequestUserId(req);
    const projectId = parseInt(String(req.params.id), 10);
    const proj = await db
      .select({ user_id: projects.user_id, conversation_id: projects.conversation_id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.user_id, userId)))
      .limit(1);
    if (!proj[0]) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (!proj[0].conversation_id) {
      res.json([]);
      return;
    }
    const msgs = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, proj[0].conversation_id))
      .orderBy(messages.createdAt);
    res.json(msgs);
  } catch (err) {
    req.log.error({ err }, "Failed to list project copilot messages");
    res.status(500).json({ error: "Failed to list project messages" });
  }
});

router.post("/projects/:id/chat", aiRateLimiter, aiDailyQuota, async (req, res) => {
  try {
    const userId = getRequestUserId(req);
    const projectId = parseInt(String(req.params.id), 10);
    const { content } = (req.body ?? {}) as { content?: unknown };
    if (typeof content !== "string" || !content.trim()) {
      res.status(400).json({ error: "content is required" });
      return;
    }
    let messageContent: string;
    try {
      messageContent = assertMaxChars(content, "Message");
    } catch (err) {
      if (rejectInputError(res, err)) return;
      throw err;
    }

    const projRows = await db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.user_id, userId))).limit(1);
    const proj = projRows[0];
    if (!proj) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    // Ensure the project has a conversation (created lazily on first message).
    let convId = proj.conversation_id;
    if (!convId) {
      const inserted = await db
        .insert(conversations)
        .values({ title: `Project: ${proj.name}`, user_id: userId })
        .returning();
      convId = inserted[0]!.id;
      await db.update(projects).set({ conversation_id: convId, updated_at: new Date() }).where(and(eq(projects.id, projectId), eq(projects.user_id, userId)));
    }

    await db.insert(messages).values({ conversationId: convId, role: "user", content: messageContent });

    // Fetch only from this owned project, then select relevant experiments
    // locally before any context leaves the server.
    const projExperiments = await db
      .select()
      .from(experiments)
      .where(and(eq(experiments.project_id, projectId), eq(experiments.user_id, userId)))
      .orderBy(desc(experiments.date));

    const chatHistory = (await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, convId))
      .orderBy(desc(messages.createdAt))
      .limit(40))
      .reverse()
      .filter((message) => message.role !== "assistant" || message.aiRequestId)
      .slice(-20);
    const relevantExperiments = selectRelevantProjectExperiments(projExperiments, messageContent);

    // Context documents the researcher attached (lab notebook, protocols, notes).
    // Optional grounding — never let a doc error (or a not-yet-migrated table)
    // break the core chat. Concatenate within a character budget.
    let docsContext = "";
    try {
      const docs = await db
        .select()
        .from(projectDocuments)
        .where(and(eq(projectDocuments.project_id, projectId), eq(projectDocuments.user_id, userId)))
        .orderBy(projectDocuments.created_at);
      if (docs.length) {
        const terms = searchTerms(messageContent);
        const rankedDocs = docs.map((doc, index) => ({
          doc,
          index,
          score: Array.from(terms).reduce(
            (score, term) => score + (`${doc.name} ${doc.content.slice(0, 8_000)}`.toLowerCase().includes(term) ? 1 : 0),
            0,
          ),
        })).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, 2);
        let budget = 12_000;
        const parts: string[] = [];
        for (const { doc: d } of rankedDocs) {
          if (budget <= 0) break;
          const snippet = d.content.slice(0, budget);
          parts.push(`### ${d.name}\n${snippet}`);
          budget -= snippet.length;
        }
        docsContext = `\n\nPROJECT CONTEXT DOCUMENTS (lab notebook / protocols / notes):\n${parts.join("\n\n")}`;
      }
    } catch (e) {
      req.log.warn({ e }, "project documents unavailable — continuing without them");
    }

    const documentNames = docsContext.match(/^### (.+)$/gm)?.map((name) => name.slice(4)) ?? [];
    const sensitiveTerms = [proj.name, ...projExperiments.map((experiment) => experiment.name), ...documentNames];
    const experimentIndex = buildRelatedExperimentContext(projExperiments, sensitiveTerms, { metadataOnly: true });
    const systemInstruction =
      `${PROJECT_SYSTEM_PROMPT}${CHAT_TONE_INSTRUCTION}\n\nPROJECT REF: current-project\nGOAL: ${proj.goal ?? "(not specified)"}\n\n` +
      `RELEVANT EXPERIMENT DETAILS:\n${relevantExperiments.length ? buildRelatedExperimentContext(relevantExperiments, sensitiveTerms, { includeData: true }) : "(none logged yet)"}\n\n` +
      `PROJECT EXPERIMENT INDEX (metadata only):\n${experimentIndex}` +
      docsContext +
      "\n\nUse only this project's material. Never infer or expose another user's data.";

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    let fullResponse = "";
    const stream = await streamAiText({
      taskType: "project_chat",
      userId,
      projectId,
      systemInstruction,
      messages: chatHistory.map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.content,
      })),
      maxTokens: 4096,
      sensitiveTerms,
    });

    for await (const chunk of stream) {
      const text = chunk.text;
      if (text) {
        fullResponse += text;
        res.write(`data: ${JSON.stringify({ content: text })}\n\n`);
      }
    }

    if (fullResponse.trim()) {
      const auditNotice = numericAuditNotice(
        fullResponse,
        `${systemInstruction}\n${chatHistory.map((message) => message.content).join("\n")}`,
      );
      if (auditNotice) {
        const warning = `\n\n> **Numeric verification notice:** ${auditNotice}`;
        fullResponse += warning;
        res.write(`data: ${JSON.stringify({ content: warning, warning: auditNotice })}\n\n`);
      }
      await db.insert(messages).values({ conversationId: convId, role: "assistant", content: fullResponse, aiRequestId: stream.requestId });
      res.write(`data: ${JSON.stringify({ done: true, request_id: stream.requestId })}\n\n`);
    } else {
      res.write(
        `data: ${JSON.stringify({
          error: "The AI returned an empty response (it may be rate-limited). Please try again.",
        })}\n\n`,
      );
    }
    res.end();
  } catch (err) {
    req.log.error({ err }, "Failed to run project chat");
    writeAiStreamError(res);
  }
});

// Synthesize a "state of the project" across all its experiments + context docs,
// saved to projects.ai_summary. Returns JSON (not streamed). Same logic also
// runs automatically (fire-and-forget) whenever an experiment in the project
// gets new data or an analysis report — see triggerProjectSynthesis in
// lib/projectSynthesis.ts, called from experiments.ts.
router.post("/projects/:id/synthesize", aiRateLimiter, aiDailyQuota, async (req, res) => {
  try {
    const userId = getRequestUserId(req);
    const projectId = parseInt(String(req.params.id), 10);
    const result = await synthesizeProject(projectId, userId);
    if ("error" in result) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Failed to synthesize project");
    res.status(aiErrorStatus(err)).json({ error: "Failed to synthesize project" });
  }
});

router.post(["/ai/general-chat", "/gemini/general-chat"], aiRateLimiter, aiDailyQuota, async (req, res) => {
  try {
    const { message: rawMessage, history: rawHistory } = req.body as {
      message?: string;
      history?: { role?: string; content?: string }[];
    };
    if (!rawMessage?.trim()) {
      res.status(400).json({ error: "Message is required" });
      return;
    }
    let message: string;
    let priorTurns: { role: "user" | "assistant"; content: string }[] = [];
    try {
      message = assertMaxChars(rawMessage, "Message");
      // The client supplies the transcript, so validate it rather than trust
      // it: known roles only, non-empty, length-capped, and only the most
      // recent few turns.
      priorTurns = (Array.isArray(rawHistory) ? rawHistory : [])
        .filter((turn): turn is { role: "user" | "assistant"; content: string } =>
          (turn?.role === "user" || turn?.role === "assistant") &&
          typeof turn.content === "string" &&
          turn.content.trim().length > 0)
        .slice(-GENERAL_CHAT_MAX_TURNS)
        .map((turn) => ({ role: turn.role, content: assertMaxChars(turn.content, "Message") }));
    } catch (err) {
      if (rejectInputError(res, err)) return;
      throw err;
    }

    const userId = getRequestUserId(req);

    // Ask Anything is the dashboard's "second brain": it answers from the
    // scientist's own logged work, not just from general biology. It used to
    // query nothing at all, so "how many of my assays failed?" got a textbook
    // answer about assays in general.
    //
    // Grounding goes through the same builder the scoped copilots use, which
    // withholds experiment names and redacts them from notes. That means this
    // can reason over what was run, when, on what instrument, and how it turned
    // out — but it cannot recall an experiment BY NAME. That restriction is
    // deliberate (identifiers must not reach the provider or the training
    // capture) and is not something to quietly relax here.
    const recent = await db
      .select()
      .from(experiments)
      .where(eq(experiments.user_id, userId))
      .orderBy(desc(experiments.created_at))
      .limit(GENERAL_CHAT_HISTORY_LIMIT);

    let historyCtx = "";
    if (recent.length > 0) {
      const history = buildLabHistory(recent);
      const clipped = history.length > GENERAL_CHAT_HISTORY_BUDGET
        ? `${history.slice(0, GENERAL_CHAT_HISTORY_BUDGET)}\n…(older experiments omitted)`
        : history;
      historyCtx = `\n\nTHE SCIENTIST'S OWN RECENT EXPERIMENTS (their real logged work, newest first). Use this whenever the question touches their history, and say plainly when it does not cover what they asked. Experiments are identified only by experiment_ref — you do not have their names, so never guess one:\n${clipped}`;
    }

    const systemInstruction = `${GENERAL_SYSTEM_PROMPT}${historyCtx}${CHAT_TONE_INSTRUCTION}`;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    let fullResponse = "";
    const stream = await streamAiText({
      taskType: "general_chat",
      userId,
      systemInstruction,
      messages: [...priorTurns, { role: "user", content: message }],
      maxTokens: 2048,
    });

    for await (const chunk of stream) {
      const text = chunk.text;
      if (text) {
        fullResponse += text;
        res.write(`data: ${JSON.stringify({ content: text })}\n\n`);
      }
    }

    if (fullResponse.trim()) {
      res.write(`data: ${JSON.stringify({ done: true, request_id: stream.requestId })}\n\n`);
    } else {
      res.write(
        `data: ${JSON.stringify({
          error: "The AI returned an empty response (it may be rate-limited). Please try again.",
        })}\n\n`,
      );
    }
    res.end();
  } catch (err) {
    req.log.error({ err }, "Failed to run general chat");
    writeAiStreamError(res);
  }
});

// ── AI protocol generation (wave 2) ───────────────────────────────────────────
// Describe a research goal → get a structured, bench-ready protocol. Grounded in
// the scientist's recent experiments for consistency. Returns JSON the frontend
// can preview and use to pre-fill a new experiment.
router.post(["/ai/generate-protocol", "/gemini/generate-protocol"], aiRateLimiter, aiDailyQuota, async (req, res) => {
  try {
    const userId = getRequestUserId(req);
    const { goal: rawGoal, assay_type: rawAssayType } = req.body as { goal?: string; assay_type?: string };
    if (!rawGoal?.trim()) {
      res.status(400).json({ error: "A research goal / description is required" });
      return;
    }
    let goal: string;
    let assayType: string | undefined;
    try {
      goal = assertMaxChars(rawGoal, "Research goal");
      assayType = rawAssayType ? assertMaxChars(rawAssayType, "Assay type", 200) : undefined;
    } catch (err) {
      if (rejectInputError(res, err)) return;
      throw err;
    }

    const recent = await db
      .select()
      .from(experiments)
      .where(eq(experiments.user_id, userId))
      .orderBy(desc(experiments.created_at))
      .limit(10);
    const historyCtx = recent.length
      ? `\n\nThe scientist's recent experiments (for context and consistency):\n${buildLabHistory(recent)}`
      : "";

    const systemInstruction = `You are an expert experimental designer for a cell and molecular biology lab. Given a research goal, design a rigorous, bench-ready protocol. Be specific and quantitative: state concentrations, volumes, timings, seeding densities, replicate counts, the plate/sample layout, and the exact controls required (positive, negative, vehicle, blank). Choose an appropriate assay and instrument. Keep it realistic, safe, and concise — no preamble.`;

    const userPrompt = `Design a protocol for this goal: ${goal}${assayType ? `\nPreferred assay type: ${assayType}` : ""}${historyCtx}

Respond in this exact JSON format:
{
  "title": "short experiment name",
  "assay_type": "...",
  "instrument": "...",
  "objective": "one or two sentences",
  "materials": ["reagent/equipment with key spec", "..."],
  "controls": ["control and its purpose", "..."],
  "plate_layout": "how samples/doses/controls are arranged",
  "steps": ["numbered, actionable step", "..."],
  "expected_readout": "what is measured and how it is interpreted",
  "suggested_analysis": "the statistics/curve fit to apply (e.g. 4PL IC50, Z'-factor)"
}`;

    const response = await generateAiJson({
      taskType: "protocol_generation",
      userId,
      systemInstruction,
      messages: [{ role: "user", content: userPrompt }],
      maxTokens: 4096,
      sensitiveTerms: recent.map((experiment) => experiment.name),
    }, StandaloneProtocolSchema);

    res.json({ ...response.data, ai_request_id: response.requestId });
  } catch (err) {
    req.log.error({ err }, "Failed to generate protocol");
    res.status(aiErrorStatus(err)).json({ error: "Failed to generate protocol" });
  }
});

export default router;
