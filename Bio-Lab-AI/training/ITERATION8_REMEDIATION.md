# Iteration 8 remediation

Iteration 7 completed on the private free Kaggle P100 run
`iambiolab/biolab-ai-iteration7-training-clean`, script version `339758439`.
The training, validation, checkpoint rotation, and adapter packaging all
completed successfully. Its intentional review assertion ran only after all 20
blind candidates had been generated. The adapter is quarantined and must not be
published or deployed.

## Audited parent evidence

- parent dataset: 800 examples, fingerprint
  `7d6425abed89fd5097f70315020158f5fff5b8eb7e2c5c9f54db8e0d09dbc0e4`;
- blind ratings fingerprint:
  `feddd9b5be8ef7ba6b6d49374ee294a06a230a13e2ffd2272cdbb2ee4821d16e`;
- release-gate report fingerprint:
  `9561b58b697a675b8163428d6bd6ac8b99b4ef8731ba1358a6db63533cb32009`;
- adapter package fingerprint:
  `ffc1d653a39beee6883a1b43bc767eaf51699abc2cd4143c6729cda521fcce24`;
- review provenance: AI-assisted scientific review performed by Codex at the
  owner's explicit request, not a human scientist rating.

The adapter passed privacy (20/20) and improved approval over the base by 20
percentage points. It failed the other three release gates: only 3/5 structured
answers followed the exact schema, measurement fidelity was 18/20, and 9/20
answers (45%) were rated 4 or 5 instead of the required 16/20 (80%). Eleven
adapter answers were not approved. One candidate mapping became visible only
after that row's assessment, so 19 of 20 assessments were strictly blind; all
ratings were locked before the remaining mappings were read.

## Dataset changes

`build_public_bootstrap_iteration8.py` is deterministic and model-free. It:

- promotes all 800 iteration-7 examples to training-only records;
- adds 36 balanced exact-decision replays;
- adds 22 direct replays covering each of the 11 failed held-out references;
- adds 12 structured-analysis schema replays;
- adds 10 protocol/SOP schema and actionability replays;
- creates 40 fresh, source-group-independent holdouts covering all nine tasks.

The resulting dataset contains exactly 920 examples with 880/20/20
train/validation/test splits and 212/5/5 structured examples. It has zero
privacy findings, no duplicate inputs, no source-group leakage, and fingerprint
`7a19335f825bbe93f7ebdccba9996044a73743b0a4ea636245501a171bf56072`.
No candidate model output is used as a label.

## Training changes

Iteration 8 keeps 4-bit NF4 Mistral 7B, FP16 compute on P100/T4-class hardware,
rank-8 `q_proj`/`v_proj` LoRA, alpha 16, dropout 0.05, effective batch size 16,
completion-only loss, and restart-safe checkpoints every five optimizer steps.
It uses two epochs at a reduced learning rate of `5e-5`.

The optimizer replay set contains 1,183 examples per epoch: 880 base training
records, 80 focused replays, 212 structured replays, and the 11 failed parent
references. Training and evaluation may run only on free cloud GPU compute.

## Release decision

The iteration-8 adapter remains quarantined until a fresh blind evaluation
passes all five release gates. Do not publish, upload to Cloudflare, or deploy
if any gate fails; prepare another audited iteration instead.
