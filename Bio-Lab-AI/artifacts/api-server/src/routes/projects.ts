import { Router, type IRouter } from "express";
import { eq, and, desc, sql } from "drizzle-orm";
import { db, projects, experiments, projectDocuments, tasks } from "@workspace/db";
import { getRequestUserId } from "../lib/requestUser";
import { decodeUpload, UploadInputError, MAX_DOCUMENT_UPLOAD_BYTES } from "../lib/uploadValidation";
import { PROTOCOL_JSON_FORMAT, parseStructuredProtocol, protocolToMarkdown, structureProtocolWithAI } from "../lib/protocol";
import { aiErrorStatus } from "../lib/ai";
import archiver from "archiver";
import { aiDailyQuota, aiRateLimiter } from "../middlewares/rateLimit";
import { assertMaxChars } from "../lib/requestLimits";
import mammoth from "mammoth";
// pdf-parse's own top-level index.js runs a debug self-test (reading a bundled
// test PDF) whenever it can't detect a CJS `module.parent` — which is always,
// once esbuild bundles this into a single file. That crashes the whole server
// at startup. Importing the internal implementation module skips that file
// entirely; it's plain CJS with no exports map, so the subpath is stable.
// (Type declared in src/types/pdf-parse-lib.d.ts.)
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import AdmZip from "adm-zip";

const router: IRouter = Router();
const MAX_DOC_CHARS = 200_000;

function requestBody(reqBody: unknown): Record<string, unknown> {
  return reqBody && typeof reqBody === "object" ? (reqBody as Record<string, unknown>) : {};
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// ── list the user's projects (with experiment counts) ──
router.get("/projects", async (req, res) => {
  try {
    const userId = getRequestUserId(req);
    const rows = await db
      .select({
        id: projects.id,
        name: projects.name,
        goal: projects.goal,
        status: projects.status,
        created_at: projects.created_at,
        updated_at: projects.updated_at,
        experiment_count: sql<number>`count(${experiments.id})`,
      })
      .from(projects)
      .leftJoin(experiments, eq(experiments.project_id, projects.id))
      .where(eq(projects.user_id, userId))
      .groupBy(projects.id)
      .orderBy(desc(projects.created_at));

    res.json(rows.map((r) => ({ ...r, experiment_count: Number(r.experiment_count) })));
  } catch (err) {
    req.log.error({ err }, "Failed to list projects");
    res.status(500).json({ error: "Failed to list projects" });
  }
});

// ── create a project ──
router.post("/projects", async (req, res) => {
  try {
    const userId = getRequestUserId(req);
    const { name, goal, status } = (req.body ?? {}) as { name?: unknown; goal?: unknown; status?: unknown };
    if (typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "A project name is required" });
    }
    const inserted = await db
      .insert(projects)
      .values({
        user_id: userId,
        name: name.trim(),
        goal: typeof goal === "string" && goal.trim() ? goal.trim() : null,
        status: typeof status === "string" && status.trim() ? status.trim() : "active",
      })
      .returning();
    return res.status(201).json(inserted[0]);
  } catch (err) {
    req.log.error({ err }, "Failed to create project");
    return res.status(400).json({ error: "Failed to create project" });
  }
});

// ── get one project + the experiments in it ──
router.get("/projects/:id", async (req, res) => {
  try {
    const userId = getRequestUserId(req);
    const id = parseInt(req.params.id, 10);
    const rows = await db
      .select()
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.user_id, userId)))
      .limit(1);
    if (!rows[0]) {
      return res.status(404).json({ error: "Project not found" });
    }
    const exps = await db
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
      .where(and(eq(experiments.project_id, id), eq(experiments.user_id, userId)))
      .orderBy(desc(experiments.created_at));

    return res.json({ ...rows[0], experiments: exps });
  } catch (err) {
    req.log.error({ err }, "Failed to get project");
    return res.status(500).json({ error: "Failed to get project" });
  }
});

// ── all tasks across every experiment in this project ──
router.get("/projects/:id/tasks", async (req, res) => {
  try {
    const userId = getRequestUserId(req);
    const projectId = parseInt(req.params.id, 10);
    if (!(await userOwnsProject(projectId, userId))) {
      return res.status(404).json({ error: "Project not found" });
    }
    const rows = await db
      .select({
        id: tasks.id,
        experiment_id: tasks.experiment_id,
        experiment_name: experiments.name,
        title: tasks.title,
        description: tasks.description,
        owner_name: tasks.owner_name,
        due_date: tasks.due_date,
        status: tasks.status,
        priority: tasks.priority,
        created_at: tasks.created_at,
      })
      .from(tasks)
      .innerJoin(experiments, eq(experiments.id, tasks.experiment_id))
      .where(and(eq(experiments.project_id, projectId), eq(tasks.user_id, userId)))
      .orderBy(desc(tasks.created_at));
    return res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Failed to list project tasks");
    return res.status(500).json({ error: "Failed to list project tasks" });
  }
});

// ── project-level protocol: one overarching plan for the whole project,
// distinct from each experiment's own SOP. Same generate/refine pattern as
// experiments.ts's protocol route, grounded on the project goal + every
// attached context document + a summary of the experiments run so far. ──
router.post("/projects/:id/protocol/generate", aiRateLimiter, aiDailyQuota, async (req, res) => {
  try {
    const userId = getRequestUserId(req);
    const projectId = parseInt(String(req.params.id), 10);

    const body = requestBody(req.body);
    let refineNote = "";
    try {
      refineNote = optionalString(body.refine_note) ? assertMaxChars(String(body.refine_note), "Refinement note") : "";
    } catch (err) {
      if (err instanceof Error && err.message.includes("Maximum length")) {
        return res.status(413).json({ error: err.message });
      }
      throw err;
    }

    const rows = await db
      .select()
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.user_id, userId)))
      .limit(1);
    const project = rows[0];
    if (!project) return res.status(404).json({ error: "Project not found" });

    const existingProtocol = project.protocol_json ? parseStructuredProtocol(project.protocol_json) : null;

    const exps = await db
      .select({ name: experiments.name, assay_type: experiments.assay_type, status: experiments.status })
      .from(experiments)
      .where(and(eq(experiments.project_id, projectId), eq(experiments.user_id, userId)))
      .orderBy(desc(experiments.created_at));
    const experimentsSummary = exps.length
      ? exps.map((e) => `- ${e.name} (${e.assay_type}, status: ${e.status})`).join("\n")
      : "(no experiments attached yet)";

    const docs = await db
      .select({ name: projectDocuments.name, content: projectDocuments.content })
      .from(projectDocuments)
      .where(and(eq(projectDocuments.project_id, projectId), eq(projectDocuments.user_id, userId)))
      .orderBy(desc(projectDocuments.created_at));
    const docsContext = docs.length
      ? docs.map((d) => `--- ${d.name} ---\n${d.content.slice(0, 8000)}`).join("\n\n")
      : "(no context documents attached)";

    const systemInstruction = `You are an expert experimental designer for a cell and molecular biology lab, writing an overarching PROJECT plan — not a single experiment's SOP. This plan should describe the project's aims, the phases/experiments needed to test them, and how they build on each other. Use "steps" for the sequence of experiments/phases (not bench pipetting steps), "materials" for shared reagents/resources across the project, and "controls" for standards that should stay consistent across every experiment in it so results are comparable.

Always end with "review_notes": a short, honestly critical list of gaps in the project plan (e.g. missing a control experiment, an assay that should come before another, no replication strategy across experiments) — be a critical reviewer, not a cheerleader.`;

    const userPrompt = existingProtocol
      ? `Refine the existing project plan below based on the scientist's note. Keep everything that still applies; change what the note asks for.

EXISTING PLAN:
${JSON.stringify(existingProtocol, null, 2)}

SCIENTIST'S REFINEMENT NOTE: ${refineNote || "(none — just re-review and tighten the existing plan given the current experiments)"}

EXPERIMENTS IN THIS PROJECT SO FAR:
${experimentsSummary}

ATTACHED CONTEXT DOCUMENTS:
${docsContext}

IMPORTANT: also fill "changes_summary" — a specific, concrete list of what you actually changed vs. the existing plan above. If you changed nothing, say so explicitly rather than leaving it empty.

Respond in this exact JSON format:
${PROTOCOL_JSON_FORMAT}`
      : `Design an overarching plan for this project.

Project name: ${project.name}
Project goal: ${project.goal ?? "(none provided — infer reasonable defaults and note assumptions in review_notes)"}

EXPERIMENTS IN THIS PROJECT SO FAR:
${experimentsSummary}

ATTACHED CONTEXT DOCUMENTS:
${docsContext}

Respond in this exact JSON format:
${PROTOCOL_JSON_FORMAT}`;

    const sensitiveTerms = [project.name, ...exps.map((e) => e.name), ...docs.map((d) => d.name)];
    const { protocol, requestId } = await structureProtocolWithAI(systemInstruction, userPrompt, {
      taskType: "protocol_generation",
      userId,
      projectId,
      sensitiveTerms,
    });

    const { changes_summary, ...protocolToPersist } = protocol;
    await db
      .update(projects)
      .set({ protocol_json: JSON.stringify(protocolToPersist), protocol_ai_request_id: requestId, updated_at: new Date() })
      .where(and(eq(projects.id, projectId), eq(projects.user_id, userId)));

    return res.json({ ...protocol, ai_request_id: requestId });
  } catch (err) {
    req.log.error({ err }, "Failed to generate project protocol");
    return res.status(aiErrorStatus(err)).json({ error: "Failed to generate project protocol" });
  }
});

// ── update a project (name / goal / status) ──
router.put("/projects/:id", async (req, res) => {
  try {
    const userId = getRequestUserId(req);
    const id = parseInt(req.params.id, 10);
    const { name, goal, status } = (req.body ?? {}) as { name?: unknown; goal?: unknown; status?: unknown };

    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (typeof name === "string" && name.trim()) patch.name = name.trim();
    if (typeof goal === "string") patch.goal = goal.trim() ? goal.trim() : null;
    if (typeof status === "string" && status.trim()) patch.status = status.trim();

    const updated = await db
      .update(projects)
      .set(patch)
      .where(and(eq(projects.id, id), eq(projects.user_id, userId)))
      .returning();
    if (!updated[0]) {
      return res.status(404).json({ error: "Project not found" });
    }
    return res.json(updated[0]);
  } catch (err) {
    req.log.error({ err }, "Failed to update project");
    return res.status(400).json({ error: "Failed to update project" });
  }
});

// ── assign / move / unassign an experiment to a project ──
// body: { project_id: number | null }  (null = ungroup). Hand-validated so we
// don't need to regen UpdateExperimentBody just to carry one field.
router.put("/experiments/:id/project", async (req, res) => {
  try {
    const userId = getRequestUserId(req);
    const expId = parseInt(req.params.id, 10);
    const { project_id } = (req.body ?? {}) as { project_id?: unknown };

    let targetProjectId: number | null = null;
    if (project_id !== null && project_id !== undefined) {
      if (typeof project_id !== "number" || !Number.isFinite(project_id)) {
        return res.status(400).json({ error: "project_id must be a number or null" });
      }
      // The target project must exist and belong to this user.
      const proj = await db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, project_id), eq(projects.user_id, userId)))
        .limit(1);
      if (!proj[0]) {
        return res.status(404).json({ error: "Project not found" });
      }
      targetProjectId = project_id;
    }

    const updated = await db
      .update(experiments)
      .set({ project_id: targetProjectId, updated_at: new Date() })
      .where(and(eq(experiments.id, expId), eq(experiments.user_id, userId)))
      .returning();
    if (!updated[0]) {
      return res.status(404).json({ error: "Experiment not found" });
    }
    return res.json(updated[0]);
  } catch (err) {
    req.log.error({ err }, "Failed to assign experiment to project");
    return res.status(400).json({ error: "Failed to assign experiment to project" });
  }
});

// ── project context documents (lab notebook, protocols, notes) ──

async function userOwnsProject(projectId: number, userId: string): Promise<boolean> {
  const proj = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.user_id, userId)))
    .limit(1);
  return !!proj[0];
}

router.get("/projects/:id/documents", async (req, res) => {
  try {
    const userId = getRequestUserId(req);
    const projectId = parseInt(req.params.id, 10);
    if (!(await userOwnsProject(projectId, userId))) {
      return res.status(404).json({ error: "Project not found" });
    }
    const docs = await db
      .select({
        id: projectDocuments.id,
        name: projectDocuments.name,
        chars: sql<number>`length(${projectDocuments.content})`,
        created_at: projectDocuments.created_at,
      })
      .from(projectDocuments)
      .where(and(eq(projectDocuments.project_id, projectId), eq(projectDocuments.user_id, userId)))
      .orderBy(desc(projectDocuments.created_at));
    return res.json(docs.map((d) => ({ ...d, chars: Number(d.chars) })));
  } catch (err) {
    req.log.error({ err }, "Failed to list project documents");
    return res.status(500).json({ error: "Failed to list documents" });
  }
});

const DOCUMENT_EXTENSIONS = ["txt", "md", "markdown", "csv", "tsv", "json", "log", "tab", "text", "docx", "pdf"];
const MAX_ZIP_ENTRIES = 100;
// Zip metadata cruft that should never become a "document" — macOS resource
// forks, DS_Store, and any dotfile/hidden-directory entry.
const ZIP_ENTRY_SKIP_RE = /(^|\/)(__MACOSX|\.DS_Store|\.[^/]+)$/i;

// Extract text from a single file buffer given its extension (already decoded
// and size-checked). Shared by the direct-upload path and each entry pulled
// out of an uploaded .zip/folder.
async function extractTextFromBuffer(buffer: Buffer, ext: string): Promise<string> {
  if (ext === "docx") {
    const { value } = await mammoth.extractRawText({ buffer });
    return value;
  }
  if (ext === "pdf") {
    const { text } = await pdfParse(buffer);
    return text;
  }
  if (buffer.includes(0)) {
    throw new UploadInputError("The text upload contains binary data.");
  }
  return buffer.toString("utf-8");
}

// Extract text from an uploaded .docx/.pdf, or pass plain text straight through.
async function extractDocumentText(fileContentB64: string, fileName: string): Promise<string> {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  const buffer = decodeUpload(fileContentB64, fileName, {
    allowedExt: DOCUMENT_EXTENSIONS,
    maxBytes: MAX_DOCUMENT_UPLOAD_BYTES,
    typeErrorMessage: "Unsupported file type. Upload a text, .docx, or .pdf file.",
  });
  return extractTextFromBuffer(buffer, ext);
}

// Explode an uploaded .zip (or a zipped folder) into one {name, content} pair
// per supported file inside it — skipping directories, hidden/system files,
// and anything not in DOCUMENT_EXTENSIONS. Each entry is capped the same way
// a direct upload would be (size, binary-content check); a single oversized
// or unreadable entry is skipped rather than failing the whole zip.
async function extractZipDocuments(zipBuffer: Buffer): Promise<{ name: string; content: string }[]> {
  const zip = new AdmZip(zipBuffer);
  const results: { name: string; content: string }[] = [];
  for (const entry of zip.getEntries()) {
    if (results.length >= MAX_ZIP_ENTRIES) break;
    if (entry.isDirectory) continue;
    const entryName = entry.entryName.replace(/\\/g, "/");
    if (ZIP_ENTRY_SKIP_RE.test(entryName)) continue;
    const ext = entryName.split(".").pop()?.toLowerCase() ?? "";
    if (!DOCUMENT_EXTENSIONS.includes(ext)) continue;

    let buffer: Buffer;
    try {
      buffer = entry.getData();
    } catch {
      continue;
    }
    if (!buffer.byteLength || buffer.byteLength > MAX_DOCUMENT_UPLOAD_BYTES) continue;

    try {
      const content = await extractTextFromBuffer(buffer, ext);
      if (content.trim()) results.push({ name: entryName, content });
    } catch {
      // Unreadable single entry (corrupt docx/pdf, binary masquerading as
      // text) — skip it, don't fail the whole zip over one bad file.
    }
  }
  return results;
}

router.post("/projects/:id/documents", async (req, res) => {
  try {
    const userId = getRequestUserId(req);
    const projectId = parseInt(req.params.id, 10);
    const { name, content, file_content_b64, file_name } = (req.body ?? {}) as {
      name?: unknown;
      content?: unknown;
      file_content_b64?: unknown;
      file_name?: unknown;
    };

    // A .zip (or a zipped folder) explodes into many documents in one request —
    // handled entirely separately since it has no single "name" and inserts more
    // than one row.
    if (typeof file_content_b64 === "string" && file_content_b64 && typeof file_name === "string" && /\.zip$/i.test(file_name)) {
      let zipBuffer: Buffer;
      try {
        zipBuffer = decodeUpload(file_content_b64, file_name, {
          allowedExt: ["zip"],
          typeErrorMessage: "Unsupported file type.",
          maxBytes: MAX_DOCUMENT_UPLOAD_BYTES,
        });
      } catch (err) {
        if (err instanceof UploadInputError) {
          return res.status(err.statusCode).json({ error: err.message });
        }
        throw err;
      }
      if (!(await userOwnsProject(projectId, userId))) {
        return res.status(404).json({ error: "Project not found" });
      }
      const extracted = await extractZipDocuments(zipBuffer);
      if (!extracted.length) {
        return res.status(422).json({ error: "Couldn't find any readable text/docx/pdf files inside this zip." });
      }
      const rows = extracted.map((d) => ({
        user_id: userId,
        project_id: projectId,
        name: d.name.slice(0, 255),
        content: d.content.length > MAX_DOC_CHARS ? d.content.slice(0, MAX_DOC_CHARS) : d.content,
      }));
      const inserted = await db
        .insert(projectDocuments)
        .values(rows)
        .returning({ id: projectDocuments.id, name: projectDocuments.name, created_at: projectDocuments.created_at });
      return res.status(201).json({ documents: inserted, count: inserted.length });
    }

    if (typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "A document name is required" });
    }

    let resolvedContent: string;
    if (typeof file_content_b64 === "string" && file_content_b64 && typeof file_name === "string" && file_name) {
      try {
        resolvedContent = await extractDocumentText(file_content_b64, file_name);
      } catch (err) {
        if (err instanceof UploadInputError) {
          return res.status(err.statusCode).json({ error: err.message });
        }
        throw err;
      }
      if (!resolvedContent.trim()) {
        return res.status(422).json({ error: "Couldn't read any text from this document. Make sure it isn't empty or a scanned image." });
      }
    } else if (typeof content === "string" && content.trim()) {
      resolvedContent = content;
    } else {
      return res.status(400).json({ error: "Document content is empty" });
    }

    // Truncate rather than reject: a long SOP or thesis is still useful context
    // up to the cap, and losing the tail beats losing the whole document. Zip
    // entries are handled the same way above.
    if (resolvedContent.length > MAX_DOC_CHARS) {
      resolvedContent = `${resolvedContent.slice(0, MAX_DOC_CHARS)}\n\n[truncated — document exceeded ${MAX_DOC_CHARS} characters]`;
    }
    if (!(await userOwnsProject(projectId, userId))) {
      return res.status(404).json({ error: "Project not found" });
    }
    const inserted = await db
      .insert(projectDocuments)
      .values({ user_id: userId, project_id: projectId, name: name.trim(), content: resolvedContent })
      .returning({ id: projectDocuments.id, name: projectDocuments.name, created_at: projectDocuments.created_at });
    return res.status(201).json(inserted[0]);
  } catch (err) {
    req.log.error({ err }, "Failed to add project document");
    return res.status(400).json({ error: "Failed to add project document" });
  }
});

router.get("/project-documents/:docId", async (req, res) => {
  try {
    const userId = getRequestUserId(req);
    const docId = parseInt(req.params.docId, 10);
    const rows = await db
      .select()
      .from(projectDocuments)
      .where(and(eq(projectDocuments.id, docId), eq(projectDocuments.user_id, userId)))
      .limit(1);
    if (!rows[0]) {
      return res.status(404).json({ error: "Document not found" });
    }
    return res.json(rows[0]);
  } catch (err) {
    req.log.error({ err }, "Failed to get project document");
    return res.status(500).json({ error: "Failed to get document" });
  }
});

router.delete("/project-documents/:docId", async (req, res) => {
  try {
    const userId = getRequestUserId(req);
    const docId = parseInt(req.params.docId, 10);
    const deleted = await db
      .delete(projectDocuments)
      .where(and(eq(projectDocuments.id, docId), eq(projectDocuments.user_id, userId)))
      .returning();
    if (!deleted[0]) {
      return res.status(404).json({ error: "Document not found" });
    }
    return res.status(204).send();
  } catch (err) {
    return res.status(500).json({ error: "Failed to delete document" });
  }
});

function safeSegment(name: string, fallback: string): string {
  const cleaned = name.trim().replace(/[\\/:*?"<>| -]/g, "-").slice(0, 100);
  return cleaned || fallback;
}

// ── export everything about a project as a .zip: a project summary, its
// context documents, and one folder per experiment with that experiment's
// protocol/report/raw data. Plain text/markdown/JSON, not rendered PDFs —
// server-side PDF rendering is a separate, not-yet-built feature. ──
router.get("/projects/:id/export.zip", async (req, res) => {
  try {
    const userId = getRequestUserId(req);
    const projectId = parseInt(req.params.id, 10);

    const rows = await db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.user_id, userId))).limit(1);
    const project = rows[0];
    if (!project) return res.status(404).json({ error: "Project not found" });

    const exps = await db
      .select()
      .from(experiments)
      .where(and(eq(experiments.project_id, projectId), eq(experiments.user_id, userId)))
      .orderBy(desc(experiments.created_at));

    const docs = await db
      .select({ name: projectDocuments.name, content: projectDocuments.content })
      .from(projectDocuments)
      .where(and(eq(projectDocuments.project_id, projectId), eq(projectDocuments.user_id, userId)));

    const projectTasks = await db
      .select({ title: tasks.title, status: tasks.status, priority: tasks.priority, experiment_id: tasks.experiment_id })
      .from(tasks)
      .innerJoin(experiments, eq(experiments.id, tasks.experiment_id))
      .where(and(eq(experiments.project_id, projectId), eq(tasks.user_id, userId)));

    const zipName = `${safeSegment(project.name, "project")}.zip`;
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err: Error) => {
      req.log.error({ err }, "Failed to build project export zip");
      if (!res.headersSent) res.status(500);
      res.end();
    });
    archive.pipe(res);

    const projectProtocol = project.protocol_json ? parseStructuredProtocol(project.protocol_json) : null;
    const taskLines = projectTasks.length
      ? projectTasks.map((t) => `- [${t.status}] (${t.priority}) ${t.title}`).join("\n")
      : "(no tasks)";
    const summaryMd = [
      `# ${project.name}\n`,
      `**Status:** ${project.status}\n`,
      project.goal ? `**Goal:** ${project.goal}\n` : "",
      `\n## Plan\n\n${projectProtocol ? protocolToMarkdown(projectProtocol) : "(no project plan generated yet)\n"}`,
      `\n## Experiments\n${exps.length ? exps.map((e) => `- ${e.name} (${e.date}, ${e.assay_type}, status: ${e.status})`).join("\n") : "(none)"}\n`,
      `\n## Tasks\n${taskLines}\n`,
      `\n## AI synthesis${project.ai_summary_generated_at ? ` (as of ${project.ai_summary_generated_at.toISOString()})` : ""}\n\n${project.ai_summary ?? "(no synthesis generated yet)"}\n`,
    ].join("");
    archive.append(summaryMd, { name: "project-summary.md" });

    docs.forEach((d, i) => {
      archive.append(d.content, { name: `context-documents/${safeSegment(d.name, `document-${i + 1}`)}.txt` });
    });

    exps.forEach((e, i) => {
      const dir = `experiments/${safeSegment(e.name, `experiment-${i + 1}`)}`;
      const expProtocol = e.protocol_json ? parseStructuredProtocol(e.protocol_json) : null;
      const expSummaryMd = [
        `# ${e.name}\n`,
        `**Date:** ${e.date}  \n**Assay type:** ${e.assay_type}  \n**Instrument:** ${e.instrument}  \n**Status:** ${e.status}\n`,
        e.notes ? `\n**Notes:** ${e.notes}\n` : "",
        `\n## Protocol\n\n${expProtocol ? protocolToMarkdown(expProtocol) : "(no protocol generated yet)\n"}`,
        `\n## AI summary\n\n${e.ai_summary ?? "(not analyzed yet)"}\n`,
        `\n## Data analysis report\n\n${e.data_analysis_report ?? "(no report generated yet)"}\n`,
      ].join("");
      archive.append(expSummaryMd, { name: `${dir}/summary.md` });
      if (e.raw_data_json) {
        archive.append(e.raw_data_json, { name: `${dir}/raw_data.json` });
      }
    });

    await archive.finalize();
    return;
  } catch (err) {
    req.log.error({ err }, "Failed to export project");
    if (!res.headersSent) res.status(500).json({ error: "Failed to export project" });
    return;
  }
});

// ── delete a project (its experiments survive; project_id is set NULL by FK) ──
router.delete("/projects/:id", async (req, res) => {
  try {
    const userId = getRequestUserId(req);
    const id = parseInt(req.params.id, 10);
    const deleted = await db
      .delete(projects)
      .where(and(eq(projects.id, id), eq(projects.user_id, userId)))
      .returning();
    if (!deleted[0]) {
      return res.status(404).json({ error: "Project not found" });
    }
    return res.status(204).send();
  } catch (err) {
    req.log.error({ err }, "Failed to delete project");
    return res.status(500).json({ error: "Failed to delete project" });
  }
});

export default router;
