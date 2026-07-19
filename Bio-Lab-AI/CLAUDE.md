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
| Auth | Clerk (Replit-managed proxy in dev; direct keys in prod) |
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
│   │       │   ├── admin.ts       # Admin-only routes
│   │       │   └── health.ts      # /api/healthz (public)
│   │       └── middlewares/
│   │           ├── requireAuth.ts         # Verifies Clerk session
│   │           ├── requireAdmin.ts        # Admin email check
│   │           └── clerkProxyMiddleware.ts # Replit-specific Clerk proxy
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

### ✅ FIXED — User Isolation
`user_id text not null` added to `experiments`, `tasks`, `experimentComments`. All queries now filter by `getAuth(req).userId`. Run `pnpm --filter @workspace/db run push` against your DB to apply the schema change.

### ✅ FIXED — Provider-neutral AI
`lib/integrations-ai` implements the provider contract and Cloudflare client. `/api/gemini/*` remains only as a temporary route alias and no longer calls Gemini.

### ✅ FIXED — Clerk Auth
`clerkProxyMiddleware` removed from `app.ts`. Using standard `clerkMiddleware()` with `CLERK_SECRET_KEY` env var. Missing Clerk keys fail closed; unauthenticated demo mode requires explicit `ENABLE_DEMO_MODE=true` and `VITE_ENABLE_DEMO_MODE=true` in local development and is refused in production.

### ✅ FIXED — Hardcoded Admin Email
Admin email now read from `ADMIN_EMAILS` env var (server) and `VITE_ADMIN_EMAIL` (frontend).

### 🔴 PENDING — DB Schema Migration
After pulling these changes, run against your production DB:
```bash
pnpm --filter @workspace/db run push
```
This adds the `user_id` column. **Existing rows will fail** — truncate or migrate them first.

### ✅ DONE — Templates Seed Data
5 templates seeded: MTT Cell Viability, ELISA (Sandwich), qPCR Gene Expression (ΔΔCt), Flow Cytometry Apoptosis, Western Blot.
Run once after DB push:
```bash
DATABASE_URL=<your_url> pnpm --filter @workspace/scripts run seed-templates
```

### ✅ DONE — Onboarding Empty State
`Dashboard.tsx` shows `<OnboardingEmptyState />` when `total_experiments === 0`.

### 🟡 TODO — PDF Export
`GET /api/experiments/:id/report.pdf` not yet built. Use puppeteer.

### ✅ DONE — UnifiedExperimentData Schema
`lib/db/src/schema/unified-data.ts` defines the canonical TypeScript types all instrument parsers must output to.
All types exported from `@workspace/db`. Use `parseRawData(json)` to safely parse `raw_data_json` from DB.

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

- **Routing**: Wouter with `base={basePath}` (important for Replit subdomain deployment)
- **Data fetching**: TanStack Query with generated hooks from `@workspace/api-client-react`
- **Styling**: Tailwind + shadcn/ui components, dark mode via `next-themes`, CSS vars for colors
- **Animation**: Framer Motion on most page/list transitions
- **SSE**: Native `EventSource` or `fetch()` with `ReadableStream` for streaming responses

---

## Deployment

### Railway (API server — recommended)

`railway.toml` is already configured. Steps:

1. Push to GitHub
2. New Railway project → "Deploy from GitHub repo"
3. Add a **PostgreSQL plugin** — Railway auto-sets `DATABASE_URL`
4. Set all env vars from `.env.example` in the Railway dashboard:
   - `AI_PROVIDER`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, and `CLOUDFLARE_MODEL`
   - `AI_ROLLOUT_OWNER_USER_IDS` and `AI_TRAINING_ADMIN_USER_IDS`
   - `CLERK_SECRET_KEY`
   - `ADMIN_EMAILS`
5. Railway runs `pnpm install && pnpm run build` then `node artifacts/api-server/dist/index.mjs`
6. After first deploy, run the DB migration + template seed:
   ```bash
   # In Railway shell (or locally with the Railway DATABASE_URL):
   pnpm --filter @workspace/db run push
   DATABASE_URL=<railway_url> pnpm --filter @workspace/scripts run seed-templates
   ```

### Frontend (Vercel — recommended)

1. Connect GitHub repo in Vercel
2. Set **Root Directory** to `artifacts/lab-copilot`
3. Build command: `cd ../.. && pnpm install && pnpm --filter @workspace/lab-copilot run build`
4. Output directory: `dist/public`
5. Set env vars: `VITE_CLERK_PUBLISHABLE_KEY`, `VITE_ADMIN_EMAIL`, `VITE_API_URL` (Railway API URL)
6. `BASE_PATH` defaults to `/` — no override needed unless deploying to a sub-path

### Local dev (no Replit)

```bash
cp .env.example .env   # fill in your values
pnpm install
# Terminal 1 — API
PORT=3001 pnpm --filter @workspace/api-server run dev
# Terminal 2 — Frontend
PORT=8081 BASE_PATH=/ pnpm --filter @workspace/lab-copilot run dev
```

For a local demo without Clerk, explicitly add `ENABLE_DEMO_MODE=true` and `VITE_ENABLE_DEMO_MODE=true` to `.env`. Do not use demo mode on a shared or production host.
