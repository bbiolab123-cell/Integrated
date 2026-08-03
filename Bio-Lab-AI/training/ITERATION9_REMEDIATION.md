# Iteration 9 remediation

Iteration 8 completed on the private free Kaggle P100 run
`iambiolab/biolab-ai-iteration8-training-clean`, script version `339787977`.
Training, validation, restart-safe checkpoint rotation, blind generation, and
adapter packaging completed successfully. The adapter is quarantined and must
not be published or deployed.

## Audited parent evidence

- parent dataset: 920 examples, fingerprint
  `7a19335f825bbe93f7ebdccba9996044a73743b0a4ea636245501a171bf56072`;
- blind ratings fingerprint:
  `7fd62c79d9f185e4744d4f1c818613f78fa8b9a9981ff148637321b24eefa5cc`;
- release-gate report fingerprint:
  `fac83d66aa6bcd90c41b5f83bf412d01c85fec1a0ac14357ace97ea8f7053c67`;
- adapter package fingerprint:
  `976d8354e6e8693e8a7ae465af79304046dcc8bd5580eefd8fe42ab76813e886`;
- review provenance: AI-assisted scientific review performed by Codex at the
  owner's explicit request, not a human scientist/owner rating.

The adapter passed exact structured validity (5/5), privacy (20/20), and the
approval-improvement gate (55% versus 15% for the pinned base, a 40-point
improvement). It failed measurement fidelity at 19/20 and the quality gate at
11/20 answers rated 4 or 5 instead of the required 16/20. Nine adapter answers
were not approved. All 20 ratings were locked before the candidate identities
were opened.

## Dataset changes

`build_public_bootstrap_iteration9.py` is deterministic and model-free. It:

- promotes all 920 iteration-8 examples to training-only records;
- adds 54 balanced exact-decision replays;
- adds 36 direct replays covering each of the nine failed held-out references;
- adds 15 structured-analysis schema and fidelity replays;
- adds 15 protocol/SOP schema and actionability replays;
- creates 40 fresh, source-group-independent holdouts covering all nine tasks.

The resulting dataset contains exactly 1,080 examples with 1,040/20/20
train/validation/test splits and 264/5/5 structured examples. It has zero
privacy findings, no duplicate inputs, no source-group leakage, and fingerprint
`1944dae6e4581232091805493062364efb5fa5dd182f6e55b57e61028b923dbd`.
No candidate model output is used as a label. Fresh protocol holdouts come only
from the pinned, open-licensed Caduceus revision and preserve source safety
language.

## Training changes

Iteration 9 keeps 4-bit NF4 Mistral 7B, FP16 compute on P100/T4-class hardware,
rank-8 `q_proj`/`v_proj` LoRA, alpha 16, dropout 0.05, effective batch size 16,
completion-only loss, and restart-safe checkpoints every five optimizer steps.
It uses two epochs at `4e-5`.

The optimizer replay set contains 1,433 examples per epoch: 1,040 base training
records, 120 focused replays, 264 structured replays, and the nine failed parent
references. Training and evaluation may run only on free cloud GPU compute.

## Release decision

The iteration-9 adapter must remain private until its fresh blind evaluation
passes every release gate. Do not publish, upload to Cloudflare, or deploy if
any gate fails; quarantine it and prepare another audited iteration instead.
