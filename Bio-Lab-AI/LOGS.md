# Operational log catalog

This catalog lists every `CRITICAL`, `ERROR`, and `WARNING` emitted by the application, browser client, build tooling, and operational scripts. Pino's `fatal` level is documented as `CRITICAL`. Pino does not define a `NOTICE` level, and this repository emits no `NOTICE` logs.

Server logs always include `time`, `level`, `pid`, `hostname`, `service=biolab-api`, and `environment`. Request-scoped logs also inherit a validated upstream `X-Request-ID` or generated UUID, method, path, and authenticated `userId`; HTTP completion logs add the resolved endpoint, W3C trace ID when supplied, response status, and duration. The request ID is returned as `X-Request-ID`. Error objects use Pino's `err` field so name, message, stack, and cause are serialized consistently. Prompts, model responses, authorization headers, cookies, and uploaded file contents are never intentionally logged.

## HTTP, startup, configuration, and access control

| Severity | Source | Event and operator response | Important fields |
| --- | --- | --- | --- |
| WARNING | `src/app.ts` (`pinoHttp.customLogLevel`) | Any HTTP 4xx response. Usually a normal validation, authentication, authorization, rate-limit, or resource-state rejection; use the status and request fields to decide whether to correct or retry. | `req.id`, `req.method`, `req.url`, `endpoint`, `userId`, `res.statusCode`, `responseTime` |
| WARNING | `src/app.ts` (`resolveCorsOrigin`) | An unapproved browser origin is denied cross-origin access. Add it to the CORS configuration only when it is trusted. | `origin`, `policy`, `retryExpected` |
| WARNING | `src/app.ts` (demo-mode branch) | Authentication is intentionally disabled in explicit local demo mode. Safe only on a trusted development machine. | `authMode`, `environment` |
| ERROR | `src/app.ts` (global error handler) | An otherwise unhandled API failure produced a sanitized response. Inspect the attached error and correlated request/dependencies. | `err`, `statusCode`, `retryExpected`, request fields |
| ERROR | `src/index.ts` (listen callback) | The server could not bind `PORT` and is not serving traffic. Check port availability and permissions before restarting. | `err`, `port`, `exitCode`, `retryExpected` |
| ERROR | `src/index.ts` (startup seed rejection) | The optional demo seed task terminated unexpectedly after the server began listening. API traffic remains available. | `err`, `database`, `retryExpected` |
| CRITICAL | `src/index.ts` (startup rejection) | Database compatibility setup failed and startup stopped. Verify connection, permissions, and migration SQL before restarting. | `err`, `database`, `exitCode`, `retryExpected` |
| ERROR | `src/lib/seed.ts` | Initial demo experiment seeding failed. The API remains available, but demo data may be absent or partial; the seed is safe to rerun. | `err`, `database`, `attemptedInsertCount`, `retryExpected` |
| WARNING | `src/lib/requestLimits.ts` | A configured request limit is not a positive integer, so the safe default is used. Correct the setting before restart if the override was intentional. | `setting`, `configuredValue`, `fallbackValue`, `fallback`, `retryExpected` |
| WARNING | `src/lib/requestUser.ts` | Clerk authentication context could not be read. The request is denied unless a trusted local user context exists. | `err`, `authProvider`, `retryExpected`, request fields |
| WARNING | `src/middlewares/requireAdmin.ts` | Clerk admin-email verification failed, so the admin request is denied. Check Clerk and the user's primary email record. | `err`, `authProvider`, `userId`, `retryExpected` |
| WARNING | `src/middlewares/rateLimit.ts` (bucket-capacity branch) | The in-memory client tracker reached its capacity guard and new client identities are temporarily blocked. Inspect traffic cardinality or abuse. | `rateLimitScope`, `trackedBuckets`, `maxTrackedBuckets`, `retryAfterSeconds`, `retryExpected` |
| WARNING | `src/middlewares/rateLimit.ts` (per-client branch) | A client exceeded its rate limit. This is expected protection; retry after the advertised interval or investigate unexpected traffic. | `rateLimitScope`, `requestCount`, `requestLimit`, `retryAfterSeconds`, `retryExpected` |
| ERROR | `src/middlewares/rateLimit.ts` (daily quota store) | The atomic AI usage counter could not be read or updated, so AI fails closed. Check the database and `ai_daily_usage`. | `err`, `database`, `quotaDay`, `requestLimit`, `retryExpected` |
| WARNING | `src/middlewares/rateLimit.ts` (daily quota exhausted) | The shared daily AI quota is exhausted. Non-AI features remain available; retry after the UTC reset. | `quotaDay`, `requestCount`, `requestLimit`, `retryAfterSeconds`, `retryExpected` |

Paths in the remaining server tables are relative to `artifacts/api-server/src/`.

## AI generation, persistence, and stored context

| Severity | Source | Event and operator response | Important fields |
| --- | --- | --- | --- |
| WARNING | `lib/ai/context.ts` | Malformed stored experiment JSON is omitted from AI context. Generation continues with reduced grounding; repair the named field. | `err`, `database`, `experimentId`, `field`, `contentLength`, `fallback`, `retryExpected` |
| WARNING | `lib/ai/service.ts` (provider retry) | A retryable provider request failed and an automatic retry is scheduled. Inspect provider/network health if all attempts fail. | `err`, `requestId`, `taskType`, `provider`, `model`, resource IDs, `attempt`, `maxAttempts`, `nextAttempt`, `delayMs`, `providerStatusCode` |
| WARNING | `lib/ai/service.ts` (metadata persistence) | The AI result succeeded but its feedback/training metadata could not be stored. Check `ai_training_examples`; user-facing generation is unaffected. | `err`, `requestId`, `taskType`, `userId`, resource IDs, `database`, `retryExpected` |
| WARNING | `lib/ai/service.ts` (empty stream) | The provider stream closed without usable content. No assistant result or training record is produced; the caller asks the user to retry. | `requestId`, `taskType`, `provider`, `model`, resource IDs, `retryExpected` |
| WARNING | `lib/ai/service.ts` (structured-output correction) | Provider output failed JSON/schema validation. Invalid data is not stored and one correction attempt runs automatically. | `requestId`, `taskType`, `provider`, `model`, resource IDs, `validationAttempt`, `maxValidationAttempts`, `validationFailure`, `validationIssueCount` |
| WARNING | `lib/projectSynthesis.ts` (numeric audit) | Project synthesis contains ungrounded numeric claims. The summary is retained with a human-verification annotation. | `projectId`, `userId`, `aiRequestId`, `validationFailure`, `responseAnnotated`, `retryExpected` |
| WARNING | `lib/projectSynthesis.ts` (nonthrowing result) | Automatic synthesis did not update the project because prerequisites or usable AI output were unavailable. The experiment change still succeeded. | `projectId`, `userId`, `statusCode`, `reason`, `retryExpected` |
| WARNING | `lib/projectSynthesis.ts` (rejection) | Automatic synthesis threw after an experiment change. The project summary may be stale; check provider/database health and rerun it. | `err`, `projectId`, `userId`, `retryExpected` |
| WARNING | `lib/protocol.ts` (stored parser) | Stored protocol JSON cannot be parsed as a structured protocol. The caller falls back to unstructured data or treats it as absent. | `err`, `field`, `contentLength`, `fallback`, `retryExpected` |
| WARNING | `lib/protocol.ts` (SOP numeric audit) | AI structuring introduced numeric claims absent from the source SOP. The protocol gets a human-review note. | `aiRequestId`, `taskType`, `userId`, resource IDs, `validationFailure`, `responseAnnotated`, `retryExpected` |

## AI training and feedback routes

| Severity | Source branch | Event and operator response | Important fields |
| --- | --- | --- | --- |
| WARNING | `routes/aiTraining.ts` — approval without correction | Training approval is rejected because no usable human correction exists. Submit a reviewed correction. | `aiRequestId`, `approvalRequested`, `rejectionReason`, `statusCode`, `retryExpected` |
| WARNING | `routes/aiTraining.ts` — generation not found | Feedback references a missing or foreign generation. Refresh and use an owned request ID. | `aiRequestId`, `database`, `statusCode`, `retryExpected` |
| WARNING | `routes/aiTraining.ts` — unchanged output | Approval is rejected because the correction equals the model output. Make a genuine human edit. | `aiRequestId`, `approvalRequested`, `rejectionReason`, `statusCode`, `retryExpected` |
| WARNING | `routes/aiTraining.ts` — update lost/not owned | The generation disappeared or was not owned when feedback was updated. Refresh before retrying. | `aiRequestId`, `database`, `statusCode`, `retryExpected` |
| WARNING | `routes/aiTraining.ts` — invalid body | Feedback input violates the API contract. Correct request ID, rating, correction, or approval fields. | `validationIssueCount`, `statusCode`, `retryExpected` |
| ERROR | `routes/aiTraining.ts` — feedback persistence | Feedback could not be stored; rating and approval remain unchanged. Check database access and schema. | `err`, `database`, `statusCode`, `retryExpected`, request fields |
| ERROR | `routes/aiTraining.ts` — status | Training readiness could not be calculated. Check stored generation access and schema. | `err`, `database`, `statusCode`, `retryExpected`, request fields |
| WARNING | `routes/aiTraining.ts` — not-ready export | An export was generated but fails release-readiness gates. Use it for review only and fill the reported gaps. | submission/export/exclusion counts, `missingTasks`, `missingSplits`, `invalidReasonCounts`, `retryExpected` |
| ERROR | `routes/aiTraining.ts` — export | No trustworthy training export was produced. Check database, policy configuration, and record integrity. | `err`, `database`, `statusCode`, `retryExpected`, request fields |

## Experiment and plate-data routes

All request-scoped rows also carry request ID, endpoint, authenticated `userId`, and the serialized error where applicable.

| Severity | Source branch | Event and operator response | Important fields |
| --- | --- | --- | --- |
| ERROR | `routes/experiments.ts` — list | Experiment collection query failed. Check database connectivity and filters. | `err`, `database`, `statusCode`, `retryExpected` |
| ERROR | `routes/experiments.ts` — dashboard | Dashboard aggregates failed. Check database connectivity and aggregate queries. | `err`, `database`, `statusCode`, `retryExpected` |
| ERROR | `routes/experiments.ts` — get | One experiment could not be loaded. Check its record and database connectivity. | `err`, `database`, `experimentId`, `statusCode`, `retryExpected` |
| WARNING | `routes/experiments.ts` — create upload validation | Creation was rejected because the attached file failed validation. Correct file type, size, or encoding. | `err`, `fileName`, `statusCode`, `retryExpected` |
| WARNING | `routes/experiments.ts` — create body validation | Creation was rejected because experiment fields violate the contract. No experiment or conversation was created. | `err`, `validationIssueCount`, `statusCode`, `retryExpected` |
| ERROR | `routes/experiments.ts` — create transaction | The experiment/conversation transaction failed. Check database connectivity and constraints. | `err`, `database`, `statusCode`, `retryExpected` |
| WARNING | `routes/experiments.ts` — update validation | An update violates the contract; stored data is unchanged. Correct the submitted fields. | `err`, `experimentId`, `validationIssueCount`, `statusCode`, `retryExpected` |
| ERROR | `routes/experiments.ts` — update persistence | An update could not be stored. Check database connectivity and constraints. | `err`, `database`, `experimentId`, `statusCode`, `retryExpected` |
| ERROR | `routes/experiments.ts` — delete | An experiment could not be deleted. Check database constraints and connectivity. | `err`, `database`, `experimentId`, `statusCode`, `retryExpected` |
| WARNING | `routes/experiments.ts` — unusable attached data | An upload contains no usable measurements; existing data is preserved. Export a populated supported layout. | `experimentId`, `fileName`, `parserReason`, `statusCode`, `retryExpected` |
| WARNING | `routes/experiments.ts` — no attached plate grid | A readable upload contains no detected 96-well grid; existing data is preserved. | `experimentId`, `fileName`, `detectedWellCount`, `statusCode`, `retryExpected` |
| WARNING | `routes/experiments.ts` — JSON validation fallback | Parsed upload validation cannot read structured JSON, so attachment continues with the raw parser result and reduced context. | `err`, `experimentId`, `fileName`, `fallback`, `retryExpected` |
| WARNING | `routes/experiments.ts` — attach validation | Data attachment failed upload validation; previous data and analysis remain unchanged. | `err`, `experimentId`, `fileName`, `statusCode`, `retryExpected` |
| ERROR | `routes/experiments.ts` — attach failure | Data could not be parsed and attached. Check file format, parser, and database. | `err`, `experimentId`, `fileName`, `dependency`, `statusCode`, `retryExpected` |
| ERROR | `routes/experiments.ts` — protocol generation | A validated experiment protocol could not be stored. Previous protocol remains unchanged. | `err`, `experimentId`, `statusCode`, `dependency`, `retryExpected` |
| WARNING | `routes/experiments.ts` — SOP validation | SOP upload failed validation; previous protocol remains unchanged. | `err`, `experimentId`, `fileName`, `statusCode`, `retryExpected` |
| ERROR | `routes/experiments.ts` — SOP processing | SOP extraction, AI structuring, or persistence failed. Inspect the named dependencies. | `err`, `experimentId`, `fileName`, `statusCode`, `dependency`, `retryExpected` |
| WARNING | `routes/experiments.ts` — report numeric audit | A data-analysis report has ungrounded numeric claims and is annotated for verification. | `experimentId`, `aiRequestId`, `validationFailure`, `responseAnnotated`, `retryExpected` |
| ERROR | `routes/experiments.ts` — data-analysis report | No complete report was generated/stored. Previous report remains available. | `err`, `experimentId`, `statusCode`, `dependency`, `retryExpected` |
| WARNING | `routes/experiments.ts` — dose-response chart fallback | An ungrounded AI chart configuration is discarded while the text answer is kept. Obtain the missing dose-series settings. | `experimentId`, `aiRequestId`, `discardedChartType`, `fallback`, `retryExpected` |
| WARNING | `routes/experiments.ts` — quantify numeric audit | A focused answer has ungrounded numeric claims and is annotated for verification. | `experimentId`, `aiRequestId`, `validationFailure`, `responseAnnotated`, `retryExpected` |
| ERROR | `routes/experiments.ts` — quantify | No validated answer/chart was stored. Check the provider and experiment data. | `err`, `experimentId`, `statusCode`, `dependency`, `retryExpected` |
| ERROR | `routes/experiments.ts` — template creation | An experiment template could not be validated or stored. Check fields and constraints. | `err`, `database`, `statusCode`, `retryExpected` |
| WARNING | `routes/experiments.ts` — stored controls fallback | Stored control metadata is malformed; analysis continues without it unless replacements were supplied. | `err`, `experimentId`, `database`, `field`, `fallback`, `retryExpected` |
| WARNING | `routes/experiments.ts` — analysis numeric audit | Experiment analysis has ungrounded numeric claims and is annotated for verification. | `experimentId`, `aiRequestId`, `validationFailure`, `responseAnnotated`, `retryExpected` |
| ERROR | `routes/experiments.ts` — analysis | No validated summary/recommendations were stored. Previous analysis remains unchanged. | `err`, `experimentId`, `statusCode`, `dependency`, `retryExpected` |
| WARNING | `routes/experiments.ts` — comparison numeric audit | A streamed comparison has ungrounded numeric claims and is annotated for verification. | experiment IDs, `aiRequestId`, `validationFailure`, `responseAnnotated`, `retryExpected` |
| ERROR | `routes/experiments.ts` — comparison | The AI comparison stream did not complete. Check the provider and both experiment records. | `err`, experiment IDs, `statusCode`, `dependency`, `retryExpected` |
| WARNING | `routes/experiments.ts` — empty spreadsheet | A readable plate workbook has no rows. Export a populated worksheet. | `fileName`, `detectedRowCount`, `statusCode`, `retryExpected` |
| WARNING | `routes/experiments.ts` — undetected plate | A readable spreadsheet has no 96-well grid. Export the expected matrix or use a delimited table. | `fileName`, `detectedWellCount`, `statusCode`, `retryExpected` |
| WARNING | `routes/experiments.ts` — plate upload validation | Plate parsing was rejected by upload validation. Correct file type, size, or encoding. | `err`, `fileName`, `statusCode`, `retryExpected` |
| ERROR | `routes/experiments.ts` — plate parser | No supported measurements could be decoded. Verify the export and parser error. | `err`, `fileName`, `component`, `statusCode`, `retryExpected` |
| WARNING | `routes/experiments.ts` — parser empty workbook | Internal file parsing returns a nonfatal error result for a workbook without rows. | `fileName`, `fileType`, `detectedRowCount`, `fallback`, `retryExpected` |
| WARNING | `routes/experiments.ts` — parser short table | Internal parsing returns a nonfatal error result for a table missing a header or data row. | `fileName`, `fileType`, `detectedRowCount`, `fallback`, `retryExpected` |
| WARNING | `routes/experiments.ts` — condition-group cap | Rows introducing condition groups beyond the supported cap are omitted. Split the condition set before grouped analysis. | `fileName`, group counts/limit, `skippedRowCount`, `fallback`, `retryExpected` |
| WARNING | `routes/experiments.ts` — parser fallback | An unexpected parser error becomes a nonfatal error result with no measurements. Verify format and inspect `err`. | `err`, `fileName`, `fileType`, `fallback`, `retryExpected` |

## Conversation and project-copilot routes

| Severity | Source branch | Event and operator response | Important fields |
| --- | --- | --- | --- |
| ERROR | `routes/gemini.ts` — list conversations | Conversation listing failed. Check query and database connectivity. | `err`, `database`, `experimentId`, `statusCode`, `retryExpected` |
| WARNING | `routes/gemini.ts` — create validation | Conversation creation input violates the API contract; no record was created. | `err`, `experimentId`, `validationIssueCount`, `statusCode`, `retryExpected` |
| ERROR | `routes/gemini.ts` — create/link | Conversation creation or experiment linking failed. Check the database and experiment reference. | `err`, `database`, `experimentId`, `statusCode`, `retryExpected` |
| ERROR | `routes/gemini.ts` — get conversation | Conversation/messages could not be loaded. Check the record and database. | `err`, `database`, `conversationId`, `statusCode`, `retryExpected` |
| ERROR | `routes/gemini.ts` — delete conversation | Conversation deletion failed; it may remain present. Check constraints and database access. | `err`, `database`, `conversationId`, `statusCode`, `retryExpected` |
| ERROR | `routes/gemini.ts` — list messages | Conversation messages could not be loaded. | `err`, `database`, `conversationId`, `statusCode`, `retryExpected` |
| WARNING | `routes/gemini.ts` — conversation numeric audit | A conversation reply has ungrounded numeric claims and is annotated for verification. | `conversationId`, `experimentId`, `aiRequestId`, `validationFailure`, `responseAnnotated`, `retryExpected` |
| ERROR | `routes/gemini.ts` — send message | No complete AI reply was produced/persisted. Check provider and conversation storage. | `err`, `conversationId`, `statusCode`, `dependency`, `retryExpected` |
| ERROR | `routes/gemini.ts` — project messages | Project copilot history could not be loaded. Check the project conversation link and database. | `err`, `database`, `projectId`, `statusCode`, `retryExpected` |
| WARNING | `routes/gemini.ts` — document fallback | Project documents were unavailable, so chat continues with project/experiment context only. Repair document-table access. | `err`, `database`, `projectId`, `fallback`, `retryExpected` |
| WARNING | `routes/gemini.ts` — project-chat numeric audit | A project reply has ungrounded numeric claims and is annotated for verification. | `projectId`, `conversationId`, `aiRequestId`, `validationFailure`, `responseAnnotated`, `retryExpected` |
| ERROR | `routes/gemini.ts` — project chat | No complete project reply was produced/persisted. Check provider, project, and conversation storage. | `err`, `projectId`, `statusCode`, `dependency`, `retryExpected` |
| ERROR | `routes/gemini.ts` — manual synthesis | No new project synthesis was stored; the previous summary remains. | `err`, `projectId`, `statusCode`, `dependency`, `retryExpected` |
| ERROR | `routes/gemini.ts` — general chat | General chat did not produce a complete response. Check provider availability/rate limits. | `err`, `statusCode`, `dependency`, `retryExpected` |
| ERROR | `routes/gemini.ts` — standalone protocol | No validated standalone protocol was returned. Check provider and recent-experiment database access. | `err`, `statusCode`, `dependency`, `retryExpected` |

## Project, document, and archive routes

| Severity | Source branch | Event and operator response | Important fields |
| --- | --- | --- | --- |
| ERROR | `routes/projects.ts` — list | Project collection query failed. Check database connectivity and aggregates. | `err`, `database`, `statusCode`, `retryExpected` |
| ERROR | `routes/projects.ts` — create | Project validation or persistence failed. Check submitted fields and constraints. | `err`, `database`, `statusCode`, `retryExpected` |
| ERROR | `routes/projects.ts` — get | Project and experiment list could not be loaded. | `err`, `database`, `projectId`, `statusCode`, `retryExpected` |
| ERROR | `routes/projects.ts` — tasks | Project tasks could not be loaded. Check project/experiment links. | `err`, `database`, `projectId`, `statusCode`, `retryExpected` |
| ERROR | `routes/projects.ts` — protocol generation | No validated project plan was stored; previous plan remains. | `err`, `projectId`, `statusCode`, `dependency`, `retryExpected` |
| ERROR | `routes/projects.ts` — update | Project update could not be stored; existing data remains. | `err`, `database`, `projectId`, `statusCode`, `retryExpected` |
| ERROR | `routes/projects.ts` — experiment assignment | Experiment project membership could not be changed. Verify ownership and constraints. | `err`, `database`, `experimentId`, `targetProjectId`, `statusCode`, `retryExpected` |
| ERROR | `routes/projects.ts` — list documents | Project document metadata could not be loaded. | `err`, `database`, `projectId`, `statusCode`, `retryExpected` |
| WARNING | `routes/projects.ts` — ZIP validation | Archive upload failed validation; no documents were imported. | `err`, `projectId`, `fileName`, `archiveType`, `statusCode`, `retryExpected` |
| WARNING | `routes/projects.ts` — partial ZIP import | Unreadable, empty, oversized, or over-limit entries were omitted; imported context is incomplete. | `projectId`, `fileName`, archive/import/skip counts, `reachedEntryLimit`, `maxImportedDocuments`, `retryExpected` |
| WARNING | `routes/projects.ts` — empty ZIP result | No readable supported documents were found in the ZIP. Repackage supported non-empty files. | `projectId`, `fileName`, `totalArchiveEntries`, `statusCode`, `retryExpected` |
| WARNING | `routes/projects.ts` — ZIP document truncation | Oversized document text was truncated before storage. Split documents if omitted context matters. | `projectId`, `fileName`, `truncatedDocumentCount`, `maxDocumentCharacters`, `retryExpected` |
| WARNING | `routes/projects.ts` — document validation | A direct document upload failed validation; nothing was stored. | `err`, `projectId`, `fileName`, `statusCode`, `retryExpected` |
| WARNING | `routes/projects.ts` — empty extracted document | A readable document contained no extractable text; nothing was stored. | `projectId`, `fileName`, `statusCode`, `retryExpected` |
| ERROR | `routes/projects.ts` — add document | Document extraction or persistence failed. Check parser and database. | `err`, `projectId`, `fileName`, `dependency`, `statusCode`, `retryExpected` |
| ERROR | `routes/projects.ts` — get document | A project document could not be loaded. | `err`, `database`, `documentId`, `statusCode`, `retryExpected` |
| ERROR | `routes/projects.ts` — delete document | A project document could not be deleted and may remain present. | `err`, `database`, `documentId`, `statusCode`, `retryExpected` |
| ERROR | `routes/projects.ts` — archive stream | ZIP streaming failed; discard any partial file and retry after checking archive resources/data. | `err`, `projectId`, `archiveType`, `responseStarted`, `retryExpected` |
| ERROR | `routes/projects.ts` — export setup | The project export could not be assembled or started. Discard partial output. | `err`, `projectId`, `archiveType`, `responseStarted`, `statusCode`, `retryExpected` |
| ERROR | `routes/projects.ts` — delete project | A project could not be deleted; it and experiment links may remain unchanged. | `err`, `database`, `projectId`, `statusCode`, `retryExpected` |

## Browser, build, and CLI logs

| Severity | Source | Event and operator response | Important fields |
| --- | --- | --- | --- |
| ERROR | `artifacts/lab-copilot/src/components/chat/CopilotChat.tsx` (stream parse) | A conversation SSE event is malformed and the visible reply may be incomplete. Retry and inspect API stream format. | `component`, `conversationId`, `endpoint`, `error` |
| ERROR | `artifacts/lab-copilot/src/components/chat/CopilotChat.tsx` (request) | Experiment copilot request did not complete. Check browser/API connectivity and retry. | `component`, `conversationId`, `endpoint`, `retryExpected`, `error` |
| ERROR | `artifacts/lab-copilot/src/components/chat/ProjectChat.tsx` (stream parse) | A project-chat SSE event is malformed and the visible reply may be incomplete. | `component`, `projectId`, `endpoint`, `error` |
| ERROR | `artifacts/lab-copilot/src/components/chat/ProjectChat.tsx` (request) | Project copilot request did not complete. Check browser/API connectivity and retry. | `component`, `projectId`, `endpoint`, `retryExpected`, `error` |
| ERROR | `artifacts/api-server/build.mjs` | The API build failed and no `dist` bundle is available. Correct the esbuild source/dependency error and rerun. | `component`, `outputDirectory`, `error` |
| ERROR | `scripts/src/seed-templates.ts` (missing configuration) | Template seeding cannot start because `DATABASE_URL` is missing. No data changed. | `component`, `database`, `exitCode`, `retryExpected` |
| ERROR | `scripts/src/seed-templates.ts` (runtime failure) | Template seeding stopped before completion. Partial inserts may remain; rerunning is safe. | `component`, `database`, `exitCode`, `retryExpected`, serialized error name/message/stack |
| ERROR | `training/validate_notebook.py` | Notebook validation failed and the notebook is not release-ready. Correct the reported gate/cell issue and rerun. | notebook name and validation error in the human-readable stderr message |

## Known correlation limits

- CORS policy callbacks receive the browser origin but not the Express request object, so denied-origin warnings do not contain a request ID.
- `parseStructuredProtocol` receives only stored text, so its warning cannot always name the project or experiment. Request-scoped callers can still be correlated through nearby request logs.
- Internal `parseFileContent` warnings include the sanitized file name/type but not an HTTP request ID because the parser is also used outside a request-scoped logger.
- Browser stream failures may occur before the server sends an AI request ID. They include endpoint and resource ID, but correlation may require matching browser and server timestamps.
- The data model is user-scoped rather than tenant-scoped. Server request logs use `userId`; there is no separate tenant identifier to emit.
- The `build_public_bootstrap*.py` dataset builders are cryptographically pinned release artifacts. Their final INFO output is structured JSON but does not contain a prose `message`; changing it would invalidate notebook attestations, so this logging-only change deliberately leaves those files untouched.
