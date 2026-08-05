# Iteration 11 remediation

Iteration 10 completed on the private free Kaggle P100 run
`iambiolab/biolab-ai-iteration10-training-clean`, script version `340011229`.
Its training, checkpoint rotation, validation, blind generation, and LoRA-only
adapter packaging completed successfully, but the adapter is quarantined and
must not be published or deployed.

## Audited parent evidence

- parent dataset: 1,280 examples, fingerprint
  `c6ff42f670bba52c14ab1c35da125a8e1c2350b31add0edb3bc16b612a5436bf`;
- locked blind-ratings fingerprint:
  `90238ab505685e23bcb293b49449ee334710641546709d82147eae8857a59cc3`;
- release-gate report fingerprint:
  `15c1cd4256bd32625b97134c273b634ae4163004afb106ca317b6ffc7b81b717`;
- adapter package fingerprint:
  `f7ad854ea8f84da28ea07dab05ea45ab14b1f1ffe0e60a437b47212cc6e8d461`;
- review provenance: AI-assisted scientific review performed by Codex at the
  owner's explicit request, not a human scientist/owner rating.

The adapter passed structured validity (5/5), privacy (20/20), and approval
improvement (40% versus 15% for the pinned base, a 25-point improvement). It
failed measurement fidelity at 18/20 and the quality gate at 8/20 answers
rated 4 or 5 instead of the required 16/20. Twelve adapter answers were not
approved. All 20 ratings were locked before candidate identities were opened.

## Dataset changes

`build_public_bootstrap_iteration11.py` is deterministic and model-free. It:

- promotes all 1,280 iteration-10 examples to training-only records;
- adds 72 balanced exact-decision replays;
- adds 84 direct replays covering each of the 12 failed held-out references;
- adds 18 structured-analysis schema and fidelity replays;
- adds 26 protocol/SOP schema and internal-consistency replays;
- creates 40 fresh, source-group-independent holdouts covering all nine tasks.

The resulting dataset contains exactly 1,520 examples with 1,480/20/20
train/validation/test splits and 410/5/5 structured examples. It has zero
privacy findings, no duplicate inputs, no source-group leakage, and fingerprint
`cdce3114a0c963510305da2c5c435c30295562adf7803c46c3dfbda79baef3c6`.
Two independent local builds produced the same bytes and manifest. No candidate
model output is used as a label. Fresh protocol holdouts come only from the
pinned, open-licensed Caduceus revision and preserve source safety language.

## Training changes

Iteration 11 keeps 4-bit NF4 Mistral 7B, FP16 compute on P100/T4-class
hardware, rank-8 `q_proj`/`v_proj` LoRA, alpha 16, dropout 0.05, effective batch
size 16, completion-only loss, and restart-safe checkpoints every five
optimizer steps. It uses two epochs at `3e-5` and a 2,102-example optimizer
plan per epoch: 1,480 base training records, 200 focused replays, 410 structured
replays, and 12 failed parent references. The lower learning rate responds to
iteration 10's widening train/validation loss gap while retaining focused
replay pressure on the observed errors.

Training examples must fit completely inside the audited 2,048-token window;
the cloud run stops before model loading if any example exceeds it.

## Release decision

The iteration-11 adapter must remain private until its fresh blind evaluation
passes every release gate. Do not publish, upload to Cloudflare, or deploy if
any gate fails; quarantine it and prepare another audited iteration instead.
