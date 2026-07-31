# Bio-Lab AI adapter training

This is the training runbook for the small Bio-Lab LoRA adapter. The website
continues to use the open Mistral base through Cloudflare while better training
data is collected. The 7B model is downloaded and trained only inside free
Google Colab or Kaggle cloud GPU sessions; the Mac prepares text, runs static
checks, and never downloads or trains model weights.

## Two honest training modes

The cloud notebook defaults to `public_bootstrap`, which can start immediately
without pretending that model-written text was reviewed by a scientist. The
base builder makes 200 examples without calling an LLM:

- 180 expert-annotated questions from
  [PubMedQA](https://huggingface.co/datasets/qiaojin/PubMedQA) at pinned
  revision `9001f2853fb87cab8d220904e0de81ac6973b318` (MIT);
- 20 explicitly allowlisted, low-risk, hand-processed protocol examples from
  [Caduceus](https://huggingface.co/datasets/Kquant03/Caduceus-Dataset) at
  pinned revision `210c578a82a18455fe337d6c3261759eaa7c7d53` (CC BY 4.0).

Iterations 2–4 deterministically extend that pinned base. The current fourth
iteration contains exactly 380 unique examples with a 340/20/20
train/validation/test split and fingerprint
`f841d3bb1700693b64d8eade9cab9bff25a62d94139df90ea627c381b3b12513`.
It promotes iteration-3 holdouts to training-only data, adds 40 targeted
contract replays, and creates fresh independent holdouts covering all nine site
tasks. The converter balances PubMedQA's yes/no/maybe decisions, removes public
author metadata from training text, and writes attribution to a separate source
manifest. Protocol targets are bounded at paragraph or line
boundaries and the complete target excerpt must also appear as source notes in
the user input, so the adapter is never taught protocol details absent from its
context. It refuses upstream revision changes, unsupported structured numbers,
duplicates, privacy-pattern matches, group leakage, missing tasks, or incorrect
split/count fingerprints. No model output is used as a training label.
Generated JSONL and manifests are ignored by Git.

Iteration 3 is quarantined: its blind review achieved 40% approval versus 0%
for the base, but failed structured validity, exact measurement fidelity, and
the 80% quality gate. It must not be uploaded or deployed. Iteration 4 exists to
correct those failures and must pass every release gate independently.

`human_export` remains the production-quality mode. Set
`TRAINING_DATA_MODE = 'human_export'` in the notebook to use the private admin
export once it is ready.

## Production data gate

The human-export production path is intentionally blocked until `/admin`
reports **Ready for Colab**. That status means the export contains:

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

For a networked data-preparation check without downloading model weights:

```sh
python3 training/build_public_bootstrap_dataset.py \
  --output training/biolab-public-bootstrap.jsonl \
  --manifest training/biolab-public-bootstrap-manifest.json
```

This check prepares text only; it does not train or download Mistral.

## Run the audited cloud notebook

Open
[the Bio-Lab training notebook](https://colab.research.google.com/github/bbiolab123-cell/Integrated/blob/main/Bio-Lab-AI/training/biolab_lora_colab.ipynb)
in the `bbiolab123` cloud account. In Google Colab select a **T4 GPU**, or import
the same notebook privately into Kaggle and select a free **P100/T4-class GPU**.
Run the cells in order. The notebook will stop instead of weakening a gate. It:

- downloads and hash-verifies the public builder in bootstrap mode;
- preserves the public-source attribution manifest with the private run audit;
- pins the base model revision and every application-level training package;
- records the actual Torch/CUDA/GPU environment in a manifest;
- repeats strict schema, provenance, privacy, duplicate, task, group-leakage,
  split, and coverage validation;
- tokenizes every example before training and refuses any example that would
  be truncated at 2,048 tokens;
- trains only completion tokens using 4-bit NF4 QLoRA, rank 8, `q_proj` and
  `v_proj`, alpha 16, dropout 0.05, two epochs, learning rate `2e-4`, and
  effective batch size 16;
- writes restart-safe checkpoints every five optimizer steps to private Google
  Drive in Colab or the private notebook output in Kaggle;
- logs numeric training metrics only in the Trainer state and persists that
  history to Drive without logging prompts or responses;
- validates that the saved adapter is unquantized LoRA-only, under 300 MB, and
  contains Cloudflare's exact required filenames;
- creates a blinded base-vs-adapter review for every held-out test example;
- blocks publishing unless every release gate in `EVALUATION.md` passes;
- uploads only the accepted adapter and non-sensitive audit manifests to a
  private Hugging Face model repository.

The public-bootstrap adapter is a pre-release initialization, not automatic
permission to replace the production model. It remains in the separate private
repository `biolab-ai-mistral-lora-public-bootstrap` and must still pass the
blind review and production contract gates.

Free GPU availability and runtime duration are not guaranteed. If the GPU gate
fails, stop and try again later. Never fall back to the Mac or enable paid
compute.

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
