# Bio-Lab AI adapter training

This is the production training runbook for the small Bio-Lab LoRA adapter.
The website continues to use the open Mistral base through Cloudflare while
corrections are collected. The 7B model is downloaded and trained only inside
Google Colab; the Mac prepares no weights and runs no training.

## Current gate

Training is intentionally blocked until `/admin` reports **Ready for Colab**.
That status means the export contains:

- at least 200 valid, scientist-corrected, explicitly approved examples;
- at least 10 exportable examples for each of the nine AI task types;
- non-empty 80/10/10 deterministic project/experiment-grouped splits;
- at least 10 examples, two independent groups, and all nine tasks in both
  validation and test;
- no malformed, unedited, duplicate, conflicting, or obvious-PII examples.

`approved_submissions` and `approved_examples` can differ. The latter is the
audited, deduplicated count that may actually be exported. A quarantined
submission must never be manually copied into the JSONL.

## Produce the dataset

1. Use **Improve AI** on a real website response.
2. Correct the scientific answer yourself. Do not paste an answer from Gemini,
   ChatGPT, or another model.
3. Remove names, filenames, email addresses, credentials, patient information,
   and other identifying details.
4. Approve the corrected answer only after checking its measurements,
   calculations, controls, and protocol claims.
5. Repeat across all feature groups and independent projects/experiments.
6. As a configured training admin, open `/admin`, inspect the coverage/split
   gate, and export `biolab-ai-training.jsonl`.

The server export:

- contains no user, request, project, or experiment IDs;
- replaces grouping and content identifiers with secret-keyed opaque hashes;
- groups every related project/experiment into exactly one split;
- quarantines malformed rows, task-tag mismatches, PII failures, duplicate
  examples, and conflicting corrections;
- includes a SHA-256 fingerprint in the admin status and download headers.

Keep the JSONL private. Do not commit it, email it, or upload it to a public
Drive folder, Hugging Face repository, Trackio Space, or notebook.

## Run the audited Colab notebook

Open
[the Bio-Lab training notebook](https://colab.research.google.com/github/bbiolab123-cell/Integrated/blob/main/Bio-Lab-AI/training/biolab_lora_colab.ipynb)
in Google Colab, select a **T4 GPU**, and run the cells in order. The notebook
will stop instead of weakening a gate. It:

- pins the base model revision and every application-level training package;
- records the actual Torch/CUDA/GPU environment in a manifest;
- repeats strict schema, provenance, privacy, duplicate, task, group-leakage,
  split, and coverage validation;
- tokenizes every example before training and refuses any example that would
  be truncated at 2,048 tokens;
- trains only completion tokens using 4-bit NF4 QLoRA, rank 8, `q_proj` and
  `v_proj`, alpha 16, dropout 0.05, two epochs, learning rate `2e-4`, and
  effective batch size 16;
- writes resumable checkpoints to the private Google Drive account;
- logs numeric training metrics locally with Trackio and persists the Trainer
  history to Drive without logging prompts or responses;
- validates that the saved adapter is unquantized LoRA-only, under 300 MB, and
  contains Cloudflare's exact required filenames;
- creates a blinded base-vs-adapter review for every held-out test example;
- blocks publishing unless every release gate in `EVALUATION.md` passes;
- uploads only the accepted adapter and non-sensitive audit manifests to a
  private Hugging Face model repository.

Colab GPU availability and runtime duration are not guaranteed. If the GPU
gate fails, stop and try again later. Do not fall back to the Mac.

## Publish to Cloudflare only after acceptance

Cloudflare needs exactly these two files from the accepted private adapter:

- `adapter_config.json`
- `adapter_model.safetensors`

Create a clean folder containing only those files, then create the fine-tune:

```sh
npx wrangler ai finetune create \
  @cf/mistral/mistral-7b-instruct-v0.2-lora \
  biolab-ai-v1 \
  ./cloudflare-adapter
```

Keep `CLOUDFLARE_LORA_ID` empty until the Cloudflare upload and private
production smoke tests succeed. Then set the returned ID only on the API
deployment, begin the staged owner/10%/50%/100% rollout, and follow
`EVALUATION.md`. Never place Cloudflare or Hugging Face tokens in the notebook
source, frontend variables, Git, or a public log.
