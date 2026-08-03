# Iteration 10 remediation

Iteration 9 completed on the private free Kaggle P100 run
`iambiolab/biolab-ai-iteration9-training-clean`, script version `339960086`.
Its training, checkpoint rotation, validation, blind generation, and LoRA-only
adapter packaging completed successfully, but the adapter is quarantined and
must not be published or deployed.

## Audited parent evidence

- parent dataset: 1,080 examples, fingerprint
  `1944dae6e4581232091805493062364efb5fa5dd182f6e55b57e61028b923dbd`;
- locked blind-ratings fingerprint:
  `84aa9248348899c9690d8d12cf3c987d090f1e676b04e886eb6cbfd8d494cec1`;
- release-gate report fingerprint:
  `5db3d76a5429cc4df1a860085aa5758c2e680b3fe63d6f2b5fb2606b588e70c5`;
- adapter package fingerprint:
  `e4a06d9804cba0412e0935ac02b5eec30cc6fd4ec106238e77de8acf18dbde64`;
- review provenance: AI-assisted scientific review performed by Codex at the
  owner's explicit request, not a human scientist/owner rating.

The adapter passed privacy (20/20) and approval improvement (35% versus 15%
for the pinned base, a 20-point improvement). It failed structured validity at
4/5, measurement fidelity at 19/20, and the quality gate at 7/20 answers rated
4 or 5 instead of the required 16/20. Thirteen adapter answers were not
approved. All 20 ratings were locked before candidate identities were opened.

## Dataset changes

`build_public_bootstrap_iteration10.py` is deterministic and model-free. It:

- promotes all 1,080 iteration-9 examples to training-only records;
- adds 54 balanced exact-decision replays;
- adds 65 direct replays covering each of the 13 failed held-out references;
- adds 18 structured-analysis schema and fidelity replays;
- adds 23 protocol/SOP schema and actionability replays;
- creates 40 fresh, source-group-independent holdouts covering all nine tasks.

The resulting dataset contains exactly 1,280 examples with 1,240/20/20
train/validation/test splits and 335/5/5 structured examples. It has zero
privacy findings, no duplicate inputs, no source-group leakage, and fingerprint
`c6ff42f670bba52c14ab1c35da125a8e1c2350b31add0edb3bc16b612a5436bf`.
Two independent local builds produced the same bytes and manifest. No candidate
model output is used as a label. Fresh protocol holdouts come only from the
pinned, open-licensed Caduceus revision and preserve source safety language.

## Training changes

Iteration 10 keeps 4-bit NF4 Mistral 7B, FP16 compute on P100/T4-class
hardware, rank-8 `q_proj`/`v_proj` LoRA, alpha 16, dropout 0.05, effective batch
size 16, completion-only loss, and restart-safe checkpoints every five
optimizer steps. It uses two epochs at `5e-5` and a 1,748-example optimizer
plan per epoch: 1,240 base training records, 160 focused replays, 335 structured
replays, and 13 failed parent references.

Blind generation allows up to 1,536 new tokens, bounded by the reference
length, so a structurally correct protocol JSON response is not rejected only
because the former evaluation cap was too short. Training examples must still
fit completely inside the audited 2,048-token training window; the cloud run
stops before model loading if any example exceeds it.

## Release decision

The iteration-10 adapter must remain private until its fresh blind evaluation
passes every release gate. Do not publish, upload to Cloudflare, or deploy if
any gate fails; quarantine it and prepare another audited iteration instead.
