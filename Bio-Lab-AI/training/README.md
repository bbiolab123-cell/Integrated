# Bio-Lab AI adapter training

The website runs the open Mistral model through Cloudflare Workers AI. This
folder contains the Google Colab training workflow for the small LoRA adapter;
it intentionally never downloads or trains the 7B model on the Mac.

## Before training

1. Use **Improve AI** in the website to correct and approve responses.
2. In `/admin`, wait for at least 200 approved examples and coverage of every
   task type.
3. Export `biolab-ai-training.jsonl`. The export is de-identified and grouped
   into train/validation/test splits by project or experiment.
4. Keep the JSONL private. Do not add it to Git or use Gemini/ChatGPT output as
   a label.

## Colab

Open `biolab_lora_colab.ipynb` in Google Colab, choose a GPU runtime, and run
the cells in order. The notebook:

- validates the JSONL and its task coverage;
- loads `mistralai/Mistral-7B-Instruct-v0.2` in 4-bit only inside Colab;
- trains a rank-8 QLoRA adapter for two epochs with TRL;
- reports training/evaluation metrics to Trackio;
- pushes only the private adapter to `<your-Hugging-Face-user>/biolab-ai-mistral-lora`.

Colab GPU availability is dynamic. If no GPU is assigned, stop the runtime and
try later; do not fall back to running this notebook locally on the 8 GB Mac.

## Upload the accepted adapter to Cloudflare

After the held-out quality checks pass, download the adapter directory from the
private Hugging Face repository and create a Cloudflare fine-tune:

```sh
npx wrangler ai finetune create \
  @cf/mistral/mistral-7b-instruct-v0.2-lora \
  biolab-ai-v1 \
  ./biolab-ai-mistral-lora
```

Put the returned ID in `CLOUDFLARE_LORA_ID` on the API deployment. Keep
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` server-side.

Do not enable the adapter unless it meets all release gates documented in
`EVALUATION.md`.
