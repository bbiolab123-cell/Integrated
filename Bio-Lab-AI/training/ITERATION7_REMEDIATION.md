# Iteration 7 remediation

Iteration 6 completed on the private free Kaggle P100 run
`iambiolab/biolab-ai-iteration6-training-clean`, script version `339602856`.
Its adapter package was valid and it passed structured-output, measurement,
privacy, and improvement gates. It was quarantined because only 11 of 20 blind
held-out answers (55%) were rated 4/5 or higher; the release gate requires 80%.
Nothing from iteration 6 may be published or deployed.

## Audited parent evidence

- parent dataset: 680 examples, fingerprint
  `05ecb3879962d71bc4a96f4df59603ce54ea43387305679f7974430a08bdb82f`;
- blind ratings fingerprint:
  `87037c31cfe214197133e36f24c1c803edc4edd04e94f259b0ae30a90b2ca6bc`;
- release-gate report fingerprint:
  `bdc9d9d7a14d7a19291ecf786db1d8041d034df74d3e38969681e5d421dd58ca`;
- failed adapter evaluations: 9 of 20;
- review provenance: AI-assisted scientific review performed by Codex at the
  owner's explicit request, not a human scientist rating.

The observed failures were wrong or incorrectly capitalized decision labels,
lost uncertainty, unsupported generalization, incomplete project-chat output,
and protocol actionability errors. They were quality failures, not privacy,
measurement-fidelity, or package-integrity failures.

## Dataset changes

`build_public_bootstrap_iteration7.py` is deterministic and model-free. It:

- promotes all 680 iteration-6 examples to training-only records;
- adds 36 balanced decision-label replays across six decision-text tasks;
- adds 18 direct replays covering each of the 9 failed held-out references;
- adds 18 structured analysis contract replays;
- adds 8 protocol/SOP actionability replays;
- creates 40 fresh, source-group-independent holdouts covering all nine tasks.

The resulting dataset contains exactly 800 examples with 760/20/20
train/validation/test splits, 172/5/5 structured examples, zero privacy
findings, no duplicate inputs, no source-group leakage, and fingerprint
`7d6425abed89fd5097f70315020158f5fff5b8eb7e2c5c9f54db8e0d09dbc0e4`.
No model output is used as a label. Earlier iterations exhausted the remaining
unused PubMedQA `maybe` source groups, so the fresh PubMedQA holdouts are
balanced yes/no only; training retains broad yes/no/maybe coverage.

## Training changes

Iteration 7 keeps 4-bit NF4 Mistral 7B, FP16 compute on P100/T4-class hardware,
rank-8 `q_proj`/`v_proj` LoRA, alpha 16, dropout 0.05, effective batch size 16,
and checkpoints every five optimizer steps. To reduce the overfitting seen in
iteration 6, it uses two epochs and learning rate `7.5e-5`.

The optimizer replay set contains 1,021 examples per epoch: 760 base training
records, 80 focused replays, 172 structured replays, and the 9 failed parent
references. Training and evaluation must run only on free cloud GPU compute.

## Release decision

The iteration-7 adapter remains quarantined until a fresh blind evaluation
passes every release gate. The test split may not be used for prompt tuning or
optimization. Do not publish, upload to Cloudflare, or deploy if any gate
fails; prepare another audited iteration instead.
