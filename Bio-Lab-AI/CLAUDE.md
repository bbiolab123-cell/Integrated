# Lab Copilot — CLAUDE.md

> This file is the single source of truth for Claude Code. Read this before touching anything.

## What This Is

**Lab Copilot** is an AI-powered biotech lab assistant. Scientists log experiments, upload plate reader data (Synergy H1 / Gen5 Excel format), get provider-neutral AI analysis, chat with a per-experiment AI copilot, track tasks and comments, and compare experiments side-by-side.

**Target user**: Bench scientist at a small biotech or academic lab using 96-well plate assays.

---

## Stack

| Layer | Tech |
|---|---|
| Monorepo | pnpm workspaces |
| Frontend | React 18 + Vite, Wouter routing, TanStack Query, Recharts, Framer Motion, shadcn/ui |
| Backend | Express 5 (ESM), esbuild bundled |
| Database | PostgreSQL 16 + Drizzle ORM |
| Validation | Zod v4, drizzle-zod, Orval codegen |
| AI | Provider-neutral interface; Cloudflare Workers AI + Mistral 7B (streaming + JSON) |
| Auth | Clerk (direct keys) |
| Node | 24 |

---

## Repository Layout

```
Bio-Lab-AI/
├── artifacts/
│   ├── api-server/       # Express API, port $PORT
│   │   └── src/
│   │       ├── app.ts             # Express app setup, Clerk middleware
│   │       ├── routes/
│   │       │   ├── index.ts       # Mounts all routers; requireAuth applied here
│   │       │   ├── experiments.ts # ALL experiment routes (CRUD, analyze, compare, templates, tasks, comments)
│   │       │   ├── gemini.ts      # Provider-neutral AI routes; filename retained for temporary aliases
│   │       │   ├── projects.ts    # Projects, project chat/synthesis, context documents
│   │       │   ├── aiTraining.ts  # Human corrections collected for adapter training
│   │       │   ├── admin.ts       # Admin-only routes
│   │       │   └── health.ts      # /api/healthz (public)
│   │       └── middlewares/
│   │           ├── requireAuth.ts         # Verifies Clerk session
│   │           ├── requireAdmin.ts        # Admin email check
│   │           └── rateLimit.ts            # Per-user AI rate limit + daily quota
│   └── lab-copilot/      # React + Vite frontend, port 8081
│       └── src/
│           ├── App.tsx            # ClerkProvider, routing
│           ├── pages/
│           │   ├── Dashboard.tsx          # Stats + charts + AskAnythingChat
│           │   ├── ExperimentList.tsx     # Search/filter table
│           │   ├── ExperimentDetail.tsx   # Tabs: suggestions / tasks / comments + AI chat
│           │   ├── ExperimentForm.tsx     # Create new experiment + file upload
│           │   ├── ExperimentEdit.tsx     # Edit existing experiment
│           │   ├── ExperimentCompare.tsx  # Side-by-side AI comparison
│           │   ├── DataAnalysisPage.tsx   # Deep SSE-streamed analysis report
│           │   ├── TemplatesPage.tsx      # Experiment templates
│           │   ├── TasksPage.tsx          # Global tasks view
│           │   ├── ProjectsPage.tsx       # Projects list
│           │   ├── ProjectDetail.tsx      # Project goal, experiments, docs, project chat
│           │   ├── LandingPage.tsx        # Public landing (signed-out)
│           │   └── AdminPage.tsx          # Admin panel
│           └── components/
│               ├── chat/CopilotChat.tsx        # SSE chat per experiment
│               ├── dashboard/AskAnythingChat.tsx
│               ├── experiment/
│               │   ├── CommentsPanel.tsx
│               │   ├── ExperimentTasksPanel.tsx
│               │   └── RecommendationActions.tsx
│               └── PlateHeatmap.tsx             # 96-well plate visualization
├── lib/
│   ├── api-spec/openapi.yaml   # OpenAPI spec — THE source of truth for API contract
│   ├── api-client-react/       # Generated TanStack Query hooks (do NOT edit manually)
│   ├── api-zod/                # Generated Zod request validators (do NOT edit manually)
│   ├── db/src/schema/          # Drizzle schema — edit here to change DB
│   └── integrations-ai/        # Provider interface + Cloudflare Workers AI client
├── training/                   # LoRA adapter dataset builders, Colab/Kaggle notebook, release gates
├── docs/                       # DATA_QUANTIFICATION_PROTOCOL.md — how the AI must quantify
└── scripts/
    └── generate_synergy_h1.py  # Test data generator for Synergy H1 Excel files
```

---

## Key Commands

```bash
# Install
pnpm install

# Type-check everything
pnpm run typecheck

# Build everything
pnpm run build

# Run API server (needs env vars)
pnpm --filter @workspace/api-server run dev

# Run frontend (dev)
pnpm --filter @workspace/lab-copilot run dev

# Push DB schema changes (dev only — destructive)
pnpm --filter @workspace/db run push

# Regenerate API hooks + Zod schemas from OpenAPI spec
pnpm --filter @workspace/api-spec run codegen
```

---

## Required Environment Variables

Copy `.env.example` → `.env` and fill in values.

```
# Database
DATABASE_URL=<postgresql-connection-string>

# Cloudflare Workers AI (server-side only)
AI_PROVIDER=cloudflare
CLOUDFLARE_ACCOUNT_ID=<cloudflare-account-id>
CLOUDFLARE_API_TOKEN=<cloudflare-workers-ai-token>
CLOUDFLARE_MODEL=@cf/mistral/mistral-7b-instruct-v0.2-lora
CLOUDFLARE_LORA_ID=

# Clerk Auth  (https://dashboard.clerk.com)
CLERK_SECRET_KEY=<clerk-secret-key>
VITE_CLERK_PUBLISHABLE_KEY=<clerk-publishable-key>

# Local-only demo escape hatch (must be explicit; refused in production)
ENABLE_DEMO_MODE=false
VITE_ENABLE_DEMO_MODE=false

# Admin access — comma-separated emails
ADMIN_EMAILS=you@example.com
VITE_ADMIN_EMAIL=you@example.com
```

---

## How to Add a New API Route

1. Add the path + schema to `lib/api-spec/openapi.yaml`
2. Run `pnpm --filter @workspace/api-spec run codegen` to regenerate hooks
3. Add the route handler in `artifacts/api-server/src/routes/experiments.ts` (or a new file)
4. Mount new file in `artifacts/api-server/src/routes/index.ts`
5. The TanStack Query hook is now available in `lib/api-client-react/src/generated/api.ts`

---

## Database Schema (Drizzle)

| Table | Key Fields |
|---|---|
| `experiments` | id, name, date, assay_type, instrument, notes, status, file_name, raw_data_json, ai_summary, ai_next_experiments_json, conversation_id |
| `conversations` | id, title, experiment_id |
| `messages` | id, conversationId, role, content |
| `tasks` | id, experiment_id, title, status, priority, owner_name, due_date |
| `experimentComments` | id, experiment_id, content, author_name |
| `experimentTemplates` | id, name, assay_type, instrument, notes |
| `recommendationActions` | id, experiment_id, recommendation_index, action_status, reviewer_name, reviewer_note |
| `admins` | id, clerk_user_id, email |
| `projects` | id, user_id, name, goal, status, ai_summary, conversation_id — optional grouping above experiments |
| `projectDocuments` | id, project_id, name, content — context docs fed to the project copilot |
| `aiTrainingExamples` | id, user_id, task, corrected output — human corrections for adapter training |

`experiments` also carries `protocol_json` (structured SOP), `plate_layout_json`
(per-well control roles), `control_summary_json` (derived control metrics), and
`data_analysis_report`.

**Edit schema** in `lib/db/src/schema/`, then run `pnpm --filter @workspace/db run push` (dev) or generate a migration for prod.

---

## AI Integration Patterns

### One-shot analysis (JSON response)
`POST /api/experiments/:id/analyze` → calls `generateAiJson()` with a Zod schema → saves the validated summary, suggestions, and request ID

### SSE streaming
`POST /api/experiments/:id/data-analysis` and `POST /api/ai/conversations/:id/messages` → use `streamAiText()` and write `data: {...}\n\n` chunks

### Models used
- `@cf/mistral/mistral-7b-instruct-v0.2-lora` through Cloudflare Workers AI
- optional `CLOUDFLARE_LORA_ID` after the adapter passes the release gates

---

## Known Issues / Next Steps

Multi-user isolation, provider-neutral AI, Clerk auth, env-driven admin emails,
template seeding, the onboarding empty state, and the `UnifiedExperimentData`
types (`lib/db/src/schema/unified-data.ts` — use `parseRawData()` to read
`raw_data_json`) are all done and no longer need tracking here.

### 🔴 PENDING — the trained adapter is not serving traffic
`training/` builds a Bio-Lab LoRA adapter (iteration 4 dataset, blind-review
gates in `training/EVALUATION.md`), but `CLOUDFLARE_LORA_ID` is unset, so the
app runs on the stock Mistral base. Training happens only in a free Colab/Kaggle
GPU session and must pass every release gate before the ID is set and the staged
owner → 10% → 50% → 100% rollout begins.

### 🔴 PENDING — plate_layout_json migration
`Integrated/PLATE_LAYOUT_SCHEMA.sql` (one idempotent `ADD COLUMN IF NOT EXISTS`)
must be applied in Neon before the server-persisted plate layout works. Schema
first, then code — otherwise the layout routes 500.

### 🟡 TODO — server-rendered PDF
`printExperimentReport.ts` produces the report client-side via the browser print
dialog, which is enough today. A real `GET /api/experiments/:id/report.pdf`
(puppeteer) is only worth building if users need it unattended or emailed.

### 🟡 Feature flags still off from the narrow launch
`compare`, `templates`, `tasks`, and `comments` are built and working but hidden
in `artifacts/lab-copilot/src/lib/features.ts`. Set `VITE_ENABLE_ALL_FEATURES=true`
to see them; flip individual flags when they belong in the product again.

---

## Auth Pattern

- **Server**: `clerkMiddleware` in `app.ts`, then `requireAuth` on all `/api` routes except `/api/healthz`. Get user via `getAuth(req).userId`.
- **Client**: `<ClerkProvider>` in `App.tsx`, `<Show when="signed-in">` wraps protected routes, `useUser()` for user info.

---

## Plate Reader Data (Synergy H1)

The app parses Synergy H1 / Gen5 Excel exports. The parser is in `experiments.ts` → `parseSynergyH1Rows()`. It extracts:
- 8×12 well matrix
- Stats: mean, SD, CV%, min, max
- Metadata: plate name, date, protocol, wavelength
- Well status: ok / blank / high / low (based on 2-sigma thresholds)

Parsed result is stored as `raw_data_json` with `_type: "plate96"`. The `PlateHeatmap` component renders it.

---

## Frontend Patterns

- **Routing**: Wouter with `base={basePath}` (`BASE_PATH` defaults to `/`)
- **Data fetching**: TanStack Query with generated hooks from `@workspace/api-client-react`
- **Styling**: Tailwind + shadcn/ui components, dark mode via `next-themes`, CSS vars for colors
- **Animation**: Framer Motion on most page/list transitions
- **SSE**: Native `EventSource` or `fetch()` with `ReadableStream` for streaming responses

---

## Deployment

**This is what actually runs today.** Both services auto-deploy from `main` —
pushing to `main` ships to production with no human in the loop.

| Piece | Target | Trigger |
|---|---|---|
| Frontend | Vercel | GitHub Actions `.github/workflows/deploy-vercel.yml` |
| Backend (`artifacts/api-server` + `lib/**`) | Render | native auto-deploy on push to `main` |
| Database | Neon | migrations applied by hand in the Neon SQL Editor |

A frontend-only change does not rebuild the backend, and vice versa — after
pushing, confirm the service you actually changed redeployed.

Render's free tier sleeps when idle, so the first request after a quiet period
cold-starts for 30–60s. That is expected, not a bug.

`railway.toml` is vestigial from an earlier plan; nothing deploys to Railway.

### Backend env vars (Render)
`DATABASE_URL`, `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `ADMIN_EMAILS`,
`AI_PROVIDER`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_MODEL`, `AI_ROLLOUT_OWNER_USER_IDS`, `AI_TRAINING_ADMIN_USER_IDS`.
Both Clerk keys must come from the same Clerk instance or `getAuth` throws.

### Frontend env vars (Vercel)
`VITE_API_URL` (the Render URL), `VITE_CLERK_PUBLISHABLE_KEY`,
`VITE_ADMIN_EMAIL`. These are baked in at build time — changing one needs a
rebuild, not just a redeploy.

### Seeding templates
```bash
DATABASE_URL=<neon_url> pnpm --filter @workspace/scripts run seed-templates
```

### Local dev

```bash
cp .env.example .env   # fill in your values
pnpm install
# Terminal 1 — API
PORT=3001 pnpm --filter @workspace/api-server run dev
# Terminal 2 — Frontend
PORT=8081 BASE_PATH=/ pnpm --filter @workspace/lab-copilot run dev
```

For a local demo without Clerk, explicitly add `ENABLE_DEMO_MODE=true` and `VITE_ENABLE_DEMO_MODE=true` to `.env`. Do not use demo mode on a shared or production host.
