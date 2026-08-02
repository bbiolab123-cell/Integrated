# BioLab AI iteration 6 remediation

Iteration 5 is quarantined. Training completed correctly on a free Kaggle P100,
but the adapter passed only two of five release gates:

- structured validity: 4/5, 80% (fail; required 100%);
- exact measurement fidelity: 19/20, 95% (fail; required 100%);
- privacy: 20/20, 100% (pass);
- rating 4 or 5: 8/20, 40% (fail; required at least 80%);
- approval-rate improvement: +15 percentage points (pass).

The review was AI-assisted at the owner's explicit request. Nineteen examples
were scored blind. Kaggle's JSON viewer exposed the first identity mapping
before that row was scored, so the first row is excluded from the secondary
strictly blind improvement calculation. This does not change the quarantine
decision because three independent gates failed.

## Failure clusters

The twelve failed adapter cases fall into four actionable groups:

1. the decision token reverses or weakens the source-supported yes/no/maybe
   conclusion;
2. evidence summaries omit a decisive negation or overstate association as a
   positive relationship;
3. structured protocol or analysis JSON is truncated or uses the wrong field
   types;
4. one response repeats a numerical value that failed the literal measurement
   check.

## Dataset construction

- Promote every iteration-5 validation/test source group to training only.
- Never use a base-model or adapter candidate as a label.
- Add 160 deterministic source-grounded replays:
  - 108 unstructured decision examples, balanced equally across all six text
    tasks and yes/no/maybe labels;
  - 36 structured experiment-analysis examples, balanced across all three
    decision labels;
  - 16 schema-strict protocol/SOP examples.
- Require exact lowercase decision tokens, concise complete answers, literal
  number/unit copying, and explicit not-specified placeholders.
- Build fresh validation and test groups from unused pinned public sources.
  PubMedQA's remaining labeled pool contains only eight unused maybe examples,
  so the fresh 36-row PubMed holdout is deterministically allocated as 14 yes,
  14 no, and 8 maybe, with all three decisions represented in both splits.
- Use four unseen low-risk computational Caduceus sources for structured
  protocol/SOP holdouts.

The resulting dataset contains exactly 680 unique examples with 640/20/20
grouped train/validation/test splits. Its pinned SHA-256 fingerprint is
`05ecb3879962d71bc4a96f4df59603ce54ea43387305679f7974430a08bdb82f`.
All nine tasks occur in both holdouts, each holdout contains five structured
examples, and the deterministic privacy scan reports zero findings.

## Training and evaluation changes

- Retain 4-bit QLoRA rank 8 with `q_proj`/`v_proj` and FP16 compute.
- Train for three epochs at `1e-4` with effective batch size 16.
- Replay the 160 balanced contract rows, all 130 structured training rows, and
  the 12 promoted iteration-5 failures once extra per epoch.
- Rotate restart-safe checkpoints every five optimizer steps.
- Increase blind generation to a 384-token floor and 1,024-token ceiling to
  reduce truncated JSON without weakening schema checks.
- Keep every release threshold unchanged.

## Compute and release policy

Training may run only on free Kaggle or free Colab GPU compute. The Mac may
rebuild and validate text but must not download Mistral weights or train the
model. Iteration 6 remains private and cannot be published, deployed, or
assigned to the website unless all five gates pass on its fresh blind holdout.
