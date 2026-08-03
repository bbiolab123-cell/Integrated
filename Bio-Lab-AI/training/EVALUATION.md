# Adapter evaluation and release gates

The held-out `test` split is never used for gradient updates, checkpoint
selection, prompt tuning, or repeated manual editing. It contains independent
source groups and every website AI task. In `human_export` mode,
human-approved Bio-Lab corrections are the reference; Gemini and ChatGPT
outputs are prohibited. In `public_bootstrap` mode, the reference completions
come only from pinned public-licensed datasets and their source manifest.

Public-bootstrap training is pre-release initialization. It does not waive the
owner's blind scientific review, the 15-point improvement requirement, or any
production contract gate, and it must not be represented as site-specific
human feedback.

## Current release status

Iterations 3–8 are quarantined and not deployable. Iteration 8 completed on its
audited 920-example dataset and improved to 55% adapter approval versus 15% for
the base. It passed structured validity (5/5), privacy (20/20), and the 15-point
improvement gate, but failed measurement fidelity (19/20) and the required 80%
quality rate (11/20 rated 4 or 5). Its review was AI-assisted at the owner's
explicit request and is not a human scientist/owner rating. Iteration 9 is
prepared as a deterministic 1,080-example dataset with a fresh 20-example test
split; no score from an earlier iteration may be reused as an iteration-9
release result.

## Blind scientific review

The Colab notebook deterministically generates one base and one adapter answer
for every test prompt and randomizes them into candidate A/B. Do not open
`blind-key.json` until the review CSV is complete.

For every candidate, the site owner records:

- a 1–5 scientific-quality rating;
- whether the response would be approved for the website;
- whether its current task-specific response schema is valid;
- whether every quoted measurement/statistic is supported by the supplied
  context, with new calculations clearly identified as derived;
- whether it contains no identity, filename, credential, patient, or
  cross-user/project information;
- concise notes for any failure.

Automated JSON parsing and unsupported-number flags are review aids. They do
not override the human fidelity and privacy checks.

## Required adapter gates

Every gate must pass in the generated `release-gate-report.json`:

- 100% valid structured responses, including the website's current schema;
- 100% measurement and calculated-statistic fidelity;
- 100% privacy and ownership-boundary pass rate;
- at least 80% of adapter answers rated 4/5 or 5/5;
- adapter approval rate at least 15 percentage points above the pinned base;
- finite train/validation loss and a valid LoRA-only adapter package;
- rank 8, only `q_proj`/`v_proj`, unquantized float adapter tensors, exact
  Cloudflare filenames, and total adapter size below 300 MB.

Any failed row fails the release. Do not average away a fabricated measurement
or privacy error.

## Private production contract tests

After uploading an accepted adapter to Cloudflare—but before public rollout—
run all current AI contracts against an owner account:

- Bioalyze summary plus exactly three follow-up suggestions;
- detailed/streaming analysis report and stored request ID;
- experiment chat and persisted history;
- experiment comparison;
- protocol generation and refinement with valid `protocol_json`;
- SOP structuring;
- project chat and synthesis using only user-owned experiments;
- Ask Anything;
- complete well/control/statistic/notes/graph/protocol context;
- structured-output retry behavior;
- clear daily-quota exhaustion response;
- prompt/response bodies absent from application logs.

The first streaming chunk must arrive within 10 seconds under normal network
conditions and the request must complete inside the configured provider
timeout. Quoted numerical values must match the supplied fixture exactly.

## Staged rollout and rollback

1. Owner-only: run the full contract suite and inspect real owner traffic.
2. 10%: monitor errors, latency, schema validity, quota behavior, and feedback.
3. 50%: repeat the same checks.
4. 100%: keep the Gemini emergency flag for seven stable days without paired
   output logging, then remove Gemini's key, package, and implementation.

Record the dataset SHA-256, base revision, adapter file hashes, Cloudflare LoRA
ID, release report, reviewer, and rollout timestamps in the private release
note. If any offline or production gate fails, clear/leave
`CLOUDFLARE_LORA_ID`, roll back, collect new human corrections, and retrain.
