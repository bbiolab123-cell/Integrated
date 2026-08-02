# BioLab AI iteration 5 remediation

Iteration 4 is quarantined. It completed training correctly and improved over
the base model, but its blind test result was not sufficient for release:

- structured validity: 5/5 (pass);
- exact measurement fidelity: 19/20 (fail; required 20/20);
- privacy: 20/20 (pass);
- rating 4 or 5: 10/20, 50% (fail; required at least 80%);
- approval-rate improvement: +50 percentage points (pass).

The review was AI-assisted at the owner's explicit request. It was performed
blind, before opening the candidate key, but it is not a human scientist rating.

## Failure clusters

The ten failed adapter cases fall into four correctable groups:

1. wrong or internally contradictory `yes`/`no`/`maybe` decisions;
2. insufficiently cautious claims when the source supports only association or
   a non-significant trend;
3. incomplete answers caused by the evaluation generation budget being too
   close to the short reference length;
4. one exact-measurement failure that merged adjacent percentages from the
   source narrative into unsupported decimal percentages.

Structured JSON and privacy behavior improved enough to pass, so iteration 5
must preserve those gains while concentrating additional capacity on concise
decision reasoning and literal measurement copying.

## Dataset construction

- Promote every iteration-4 validation/test source group to training only.
- Use the public, source-grounded reference answer as the target; never use a
  base-model or adapter candidate as a label.
- Add 60 deterministic strict-contract training variants:
  - 42 concise decision variants across the six unstructured PubMed tasks;
  - 12 structured experiment-analysis variants;
  - 6 structured protocol/SOP variants.
- Require all decision targets to start with exactly lowercase
  `Decision: yes.`, `Decision: no.`, or `Decision: maybe.` and to finish as a
  complete response.
- In strict prompts, require quoted numbers to be copied character-for-character
  from the source. If a source value is ambiguous, the answer must omit it.
- Build fresh, unseen validation and test groups from pinned public sources,
  retaining all nine task types and five structured examples in each holdout.
- Keep the test split blinded and never train on the new holdout groups.

Target layout: 480 unique examples with a 440/20/20 grouped split. The final
fingerprint must be computed after deterministic construction and pinned in the
notebook before cloud training begins.

## Evaluation corrections

- Increase the deterministic review generation floor from 128 to 256 new
  tokens while retaining the 768-token ceiling.
- Mark an unstructured response schema-invalid unless its first line exactly
  matches the decision contract and the response is complete.
- Keep automated numeric flags advisory for the blind reviewer, then require
  100% literal or explicitly derived measurement fidelity at the gate.
- Keep every existing release threshold unchanged. A larger output budget is
  not permission to weaken scientific or schema requirements.

## Compute and release policy

Training may run only on free Kaggle or free Colab GPU compute. The Mac may
build and validate text but must not download the Mistral base weights or train
the model. The iteration-4 adapter remains local/private and must not be
published, uploaded to Cloudflare, assigned to `CLOUDFLARE_LORA_ID`, or served
to website users.

Iteration 5 may proceed to private publishing and owner-only smoke tests only
after all five gates pass on the fresh blind holdout.
