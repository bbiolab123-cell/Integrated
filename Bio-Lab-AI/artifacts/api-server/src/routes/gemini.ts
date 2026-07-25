import { Router, type IRouter, type Response } from "express";
import { eq, desc, and } from "drizzle-orm";
import { db, conversations, messages, experiments, projects, projectDocuments } from "@workspace/db";
import {
  CreateGeminiConversationBody,
  SendGeminiMessageBody,
  ListGeminiConversationsQueryParams,
} from "@workspace/api-zod";
import { generateContentWithRetry, generateContentStreamWithRetry } from "../lib/aiRetry";
import { analysisKnowledgeBlock, assayGuidanceBlock } from "../lib/assayKnowledge";
import { parseStructuredProtocol } from "../lib/protocol";
import { synthesizeProject } from "../lib/projectSynthesis";
import { getRequestUserId } from "../lib/requestUser";
import { aiRateLimiter } from "../middlewares/rateLimit";
import { assertMaxChars } from "../lib/requestLimits";

const router: IRouter = Router();

const LAB_SYSTEM_PROMPT = `You are an expert cell biologist and lab copilot with access to this lab's full experiment history.
Think like a bench scientist: when asked about an experiment, reason from its protocol/notes — what was it trying to test, what result was expected, and does the data match? If results are off, diagnose the likely cause (distinguish a technical problem from a real biological finding) and cite the specific wells/numbers. Always reference specific experiments by name. Be specific, quantitative, and actionable.`;

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

const GENERAL_SYSTEM_PROMPT = `You are an expert biotech and cell biology advisor.
Answer general scientific questions, explain concepts, help with protocol design, and discuss biotech topics. Be concise and scientific.`;

const PROJECT_SYSTEM_PROMPT = `You are an expert cell biologist and research strategist acting as the copilot for an entire research PROJECT.
You are given the project's goal and every experiment logged under it. Reason across the whole project, not one plate:
connect findings between experiments, flag patterns, contradictions, and gaps, and recommend concrete next experiments
that advance the project's goal. Always reference specific experiments by name. Be specific, quantitative, and actionable.`;

type ConversationRow = typeof conversations.$inferSelect;
type ExperimentRow = typeof experiments.$inferSelect;

function formatExperimentContext(experiment: ExperimentRow): string {
  const conditions = experiment.notes ?? "None";
  const results = experiment.ai_summary ?? "None";
  return `${experiment.name}, ${experiment.date}, ${experiment.status}, conditions: ${conditions}, results: ${results}`;
}

function buildLabHistory(experimentRows: ExperimentRow[]): string {
  return experimentRows
    .map((experiment, index) => `Experiment ${index + 1}: ${formatExperimentContext(experiment)}`)
    .join("\n");
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

router.get("/gemini/conversations", async (req, res) => {
  try {
    const userId = getRequestUserId(req);
    const query = ListGeminiConversationsQueryParams.parse(req.query);
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
    req.log.error({ err }, "Failed to list Gemini conversations");
    res.status(500).json({ error: "Failed to list conversations" });
  }
});

router.post("/gemini/conversations", async (req, res) => {
  try {
    const body = CreateGeminiConversationBody.parse(req.body);
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
    req.log.error({ err }, "Failed to create Gemini conversation");
    res.status(400).json({ error: "Failed to create conversation" });
  }
});

router.get("/gemini/conversations/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
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
    req.log.error({ err }, "Failed to get Gemini conversation");
    res.status(500).json({ error: "Failed to get conversation" });
  }
});

router.delete("/gemini/conversations/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const userId = getRequestUserId(req);
    const deleted = await db.delete(conversations).where(and(eq(conversations.id, id), eq(conversations.user_id, userId))).returning();
    if (!deleted[0]) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.status(204).send();
  } catch (err) {
    req.log.error({ err }, "Failed to delete Gemini conversation");
    res.status(500).json({ error: "Failed to delete conversation" });
  }
});

router.get("/gemini/conversations/:id/messages", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
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
    req.log.error({ err }, "Failed to list Gemini messages");
    res.status(500).json({ error: "Failed to list messages" });
  }
});

router.post("/gemini/conversations/:id/messages", aiRateLimiter, async (req, res) => {
  try {
    const convId = parseInt(String(req.params.id), 10);
    const userId = getRequestUserId(req);
    const body = SendGeminiMessageBody.parse(req.body);
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

    const chatHistory = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, convId))
      .orderBy(messages.createdAt);

    const allExperiments = await db
      .select()
      .from(experiments)
      .where(eq(experiments.user_id, userId))
      .orderBy(desc(experiments.date));

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
    // The chat must see the uploaded plate data itself, not just an AI-generated
    // report — the scientist can (and does) ask about the data the moment it's
    // uploaded, before ever clicking "Bioalyze". Without this, the chat only
    // knows about data_analysis_report/ai_summary, which don't exist until a
    // report has been explicitly generated — a real blind spot, not a design choice.
    let rawDataContext = "";
    if (exp?.raw_data_json) {
      try {
        const parsed = JSON.parse(exp.raw_data_json);
        rawDataContext = `\n\nUPLOADED PLATE/EXPERIMENT DATA for this experiment (parsed from the raw upload — use this directly, including specific well IDs and values, even if no report has been generated yet):\n${JSON.stringify(parsed, null, 2).slice(0, 6000)}`;
      } catch {
        // raw_data_json failed to parse — omit rather than send garbage to the model.
      }
    }
    // The full Data Analysis report (if one has been generated) is specific to
    // THIS experiment, so it's appended only here — not in buildLabHistory's
    // one-line-per-experiment summaries, which would bloat every related
    // experiment mention with a full report each time.
    const dataReportContext = exp?.data_analysis_report
      ? `\n\nDETAILED DATA ANALYSIS REPORT for this experiment (already generated — reference it directly rather than re-deriving from raw data when answering):\n${exp.data_analysis_report.slice(0, 6000)}`
      : "";
    systemInstruction += `\n\nFULL LAB HISTORY:\n${buildLabHistory(allExperiments)}\n\nCURRENT EXPERIMENT: ${exp ? formatExperimentContext(exp) : "None"}${rawDataContext}${dataReportContext}\n\nSCIENTIST QUESTION: ${content}`;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    let fullResponse = "";

    const stream = await generateContentStreamWithRetry({
      model: "gemini-2.5-flash",
      contents: chatHistory.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
      config: {
        systemInstruction,
        maxOutputTokens: 8192,
        // gemini-2.5-flash spends "thinking" tokens from the output budget; without
        // this it can burn the whole budget thinking and stream ZERO text, leaving
        // the user with their message and no reply. Disable thinking for chat.
        thinkingConfig: { thinkingBudget: 0 },
      },
    });

    for await (const chunk of stream) {
      const text = chunk.text;
      if (text) {
        fullResponse += text;
        res.write(`data: ${JSON.stringify({ content: text })}\n\n`);
      }
    }

    if (fullResponse.trim()) {
      await db
        .insert(messages)
        .values({ conversationId: convId, role: "assistant", content: fullResponse });
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
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
    req.log.error({ err }, "Failed to send Gemini message");
    writeAiStreamError(res);
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

router.post("/projects/:id/chat", aiRateLimiter, async (req, res) => {
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

    // Ground the AI in the project's goal + every experiment in THIS project.
    const projExperiments = await db
      .select()
      .from(experiments)
      .where(and(eq(experiments.project_id, projectId), eq(experiments.user_id, userId)))
      .orderBy(desc(experiments.date));

    const chatHistory = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, convId))
      .orderBy(messages.createdAt);

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
        let budget = 60_000;
        const parts: string[] = [];
        for (const d of docs) {
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

    const systemInstruction =
      `${PROJECT_SYSTEM_PROMPT}${CHAT_TONE_INSTRUCTION}\n\nPROJECT: ${proj.name}\nGOAL: ${proj.goal ?? "(not specified)"}\n\n` +
      `EXPERIMENTS IN THIS PROJECT:\n${projExperiments.length ? buildLabHistory(projExperiments) : "(none logged yet)"}` +
      docsContext +
      `\n\nSCIENTIST QUESTION: ${messageContent}`;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    let fullResponse = "";
    const stream = await generateContentStreamWithRetry({
      model: "gemini-2.5-flash",
      contents: chatHistory.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
      config: {
        systemInstruction,
        maxOutputTokens: 8192,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });

    for await (const chunk of stream) {
      const text = chunk.text;
      if (text) {
        fullResponse += text;
        res.write(`data: ${JSON.stringify({ content: text })}\n\n`);
      }
    }

    if (fullResponse.trim()) {
      await db.insert(messages).values({ conversationId: convId, role: "assistant", content: fullResponse });
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
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
router.post("/projects/:id/synthesize", aiRateLimiter, async (req, res) => {
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
    res.status(500).json({ error: "Failed to synthesize project" });
  }
});

router.post("/gemini/general-chat", aiRateLimiter, async (req, res) => {
  try {
    const { message: rawMessage } = req.body as { message?: string };
    if (!rawMessage?.trim()) {
      res.status(400).json({ error: "Message is required" });
      return;
    }
    let message: string;
    try {
      message = assertMaxChars(rawMessage, "Message");
    } catch (err) {
      if (rejectInputError(res, err)) return;
      throw err;
    }

    // Inject the user's own experiment history so "Ask Anything" can answer
    // questions about their real data (the "second brain" behaviour).
    const userId = getRequestUserId(req);
    const experimentRows = await db
      .select()
      .from(experiments)
      .where(eq(experiments.user_id, userId))
      .orderBy(desc(experiments.created_at))
      .limit(30);

    const systemInstruction =
      (experimentRows.length > 0
        ? `${LAB_SYSTEM_PROMPT}\n\nThis scientist's most recent experiments:\n${buildLabHistory(
            experimentRows,
          )}\n\nWhen the question relates to their work, ground your answer in these experiments and cite them by name. For general scientific questions, answer normally.`
        : GENERAL_SYSTEM_PROMPT) + CHAT_TONE_INSTRUCTION;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    let fullResponse = "";
    const stream = await generateContentStreamWithRetry({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: message }] }],
      config: {
        systemInstruction,
        maxOutputTokens: 4096,
        // See chat route: disable thinking so 2.5-flash doesn't stream an empty reply.
        thinkingConfig: { thinkingBudget: 0 },
      },
    });

    for await (const chunk of stream) {
      const text = chunk.text;
      if (text) {
        fullResponse += text;
        res.write(`data: ${JSON.stringify({ content: text })}\n\n`);
      }
    }

    if (fullResponse.trim()) {
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
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
router.post("/gemini/generate-protocol", aiRateLimiter, async (req, res) => {
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

    const response = await generateContentWithRetry({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      config: {
        systemInstruction,
        maxOutputTokens: 8192,
        responseMimeType: "application/json",
        thinkingConfig: { thinkingBudget: 0 },
      },
    });

    const text = response.text ?? "{}";
    let protocol: unknown;
    try {
      protocol = JSON.parse(text);
    } catch {
      res.status(502).json({ error: "AI returned a malformed protocol — please try again." });
      return;
    }

    res.json(protocol);
  } catch (err) {
    req.log.error({ err }, "Failed to generate protocol");
    res.status(500).json({ error: "Failed to generate protocol" });
  }
});

export default router;
