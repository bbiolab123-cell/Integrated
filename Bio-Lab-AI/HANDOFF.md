# Bioalyzer — handoff

_Written 2026-08-19. Replaces `FEATURE_AUDIT.md` (June 8), which is now stale in
ways that will mislead you: it still describes Gemini and Railway, and 9 of its
10 open items are done._

Read `CLAUDE.md` first for architecture. This file is the current state, what to
do next, and the traps.

---

## 1. Where things stand

The plate-reader path is complete and tested: Gen5 import → 96-well heatmap →
Z′-factor, CV%, pass/fail → IC50/dose-response → AI analysis and chat. Projects,
protocol design, exports (PNG/CSV/PDF), and read-only share links all work.

**61 tests** run with no database and no network:

```bash
pnpm --filter @workspace/api-server run test   # 50
pnpm --filter @workspace/lab-copilot run test  # 21
```

The real gate before any push:

```bash
pnpm run typecheck && pnpm run build
```

## 2. The moat, honestly

The stated moat is "the AI learns from what the lab generates." **That loop is
currently broken in the middle.** Three separate facts:

1. **The adapter trains on public data.** `training/build_public_bootstrap_*.py`
   pulls from PubMedQA and Caduceus. It has never seen a plate, a Z′-factor, or
   a user's experiment. It is a generic biology tune.
2. **Iteration 11 fails its own release gate.** It passed structured validity
   (5/5), measurement fidelity (20/20), privacy (20/20), and the improvement
   gate (30% adapter approval vs 5% base) — but scored **30% on quality against
   a required 80%** (6/20 answers rated 4–5). `training/EVALUATION.md` has the
   detail. It is quarantined and must not be served.
3. **Human corrections go nowhere.** `ImproveAiDialog` writes to
   `aiTrainingExamples`, `trainingDataset.ts` exports it — and **nothing reads
   that export.** This is the dead end. Fixing it is the highest-leverage work
   on the moat.

The adapter cannot be served by accident: `CLOUDFLARE_LORA_ID` throws unless
`AI_LORA_RELEASE_STATUS=accepted` with attested dataset/adapter/report hashes,
and any rollout above 0% additionally needs a passed smoke test.

**Retraining now just produces iteration 12 of the same generic model.** The
order that works is: close the correction loop → collect real lab corrections →
then retrain, and have an actual scientist do the blind review (the iteration-11
review was AI-assisted, which `EVALUATION.md` says is not a substitute).

Meanwhile there is a faster lever that needs no GPU: **give the model computed
facts instead of asking it to infer.** `plateDiagnostics.ts` is the worked
example — the prompt had always said "check for edge effects" while nothing
computed them, so every such claim was an impression. Now it is arithmetic the
model is told not to contradict. Replicate CV, cross-run trend detection, and
anomaly-vs-history are the same shape of win.

## 3. Next work, in order

1. **Close the correction loop.** Make `aiTrainingExamples` reach the dataset
   builder, and show a count in the admin panel — right now you cannot tell how
   far you are from having enough real data to train on.
2. **Per-well CV%.** `cv_pct` is hardcoded `null` for every well
   (`plateParser.ts`), while the masterplan lists it as a P1 ship-now feature.
   Either compute it from replicate groups or drop the field — it currently
   claims something untrue.
3. **More computed grounding.** Replicate CV, trend detection across runs,
   anomaly-vs-history.
4. **qPCR import** (Bio-Rad CFX / QuantStudio) — the largest adjacent user base.

## 4. Traps that have already cost real time

**Additive columns go in `ensureAiTrainingSchema.ts`, not just the Drizzle
schema.** Drizzle emits an explicit column list, so a column that exists in the
schema but not the database fails **every** experiment query, not just the
feature that added it. Adding `plate_layout_json` to the schema alone took the
API down on 2026-08-18. That file runs at startup and reaches production on
deploy. Destructive changes do NOT belong there.

**`main` auto-deploys to production with no human gate.** `render.yaml` now sets
`autoDeployTrigger: checksPass`, so a red build no longer ships itself — but a
green build ships instantly. Work on a branch.

**`ai.test.ts` needs no database.** `testSetup.ts` supplies a placeholder
`DATABASE_URL`. If you see "database unavailable" in test output, that is an
intentional fixture, not a failure.

**Every hand-written frontend fetch must use `apiFetch`.** Frontend (Vercel) and
API (Render) are different origins; a relative `fetch("/api/...")` hits Vercel
with no token and 401s silently.

**Every route that touches user data must filter by `getAuth(req).userId`.**
The one deliberate exception is `routes/publicShare.ts`, which is mounted ahead
of `requireAuth` and returns only the allowlist in `lib/publicExperiment.ts`.

**AI identifiers are redacted on purpose.** Experiment names, filenames, and
user ids never reach the provider — `buildRelatedExperimentContext` refers to
experiments as `related-1`. This is why Ask Anything can answer "what have I
run and how did it go" but not "when did we last test compound 14". Lifting it
is a privacy decision, not a code change.

**Verify on the live URL, not by reading code.** "Verified by reading code" has
been wrong here repeatedly. `healthz` returning 200 proves nothing about the
experiment path — it does not touch that table. Sign in and load an experiment.

## 5. What only Rup can do

- Authenticated click-through (no Clerk session available to an agent).
- Neon SQL, though additive columns no longer need it (see §4).
- Training runs — free Colab/Kaggle GPU only, never paid compute.
- Setting any Cloudflare/Clerk/Neon secret.

## 6. Recent history worth knowing

Six days of work through 2026-08-19 fixed defects that were silently corrupting
results, each with tests:

- **IC50 was wrong when a curve did not reach its plateaus.** The 4PL clamped
  top/bottom to the observed response extremes; a true IC50 of 1000 came back as
  40 and was flagged as measured. Plateaus are now solved exactly per grid
  candidate (separable least squares).
- **The killed end of dose-response curves was being discarded.** Any well in the
  bottom 5% of the range was labelled "blank" — on a real MTT plate that was 16
  of 96 wells, dropped before the curve was fitted. Only a missing read is blank
  now.
- **Doses were assigned after filtering**, so one unread well slid every later
  well onto its neighbour's concentration.
- **The plate parser could silently lose its entire first row** (84 wells instead
  of 96, no error) when readings happened to look like a column header.
- **Ask Anything queried nothing** despite the June audit ranking it first. It is
  now grounded in the scientist's last 12 experiments, and is multi-turn.

If you are comparing numbers against anything recorded before this: **IC50
values moved** (more accurate, but moved) and **blank counts dropped**.
