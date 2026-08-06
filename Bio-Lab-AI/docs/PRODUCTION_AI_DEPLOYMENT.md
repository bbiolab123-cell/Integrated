# Production deployment: Bio-Lab AI

This repository is deployable with a Vercel frontend and a free Render API.
The API uses Cloudflare's open Mistral base model until a future LoRA passes
every offline and production release gate. Iteration 11 is quarantined, so its
files must not be uploaded and `CLOUDFLARE_LORA_ID` must remain unset.

## Deployment invariants

- Use only the Bio Lab / `bbiolab123` accounts.
- Never put Cloudflare, Clerk, database, or training-export secrets in Vercel
  frontend variables, Git, screenshots, or logs.
- Keep the Render service on the free plan and leave automatic paid scaling off.
- Set `AI_ROLLOUT_PERCENT=0` for the first production deployment. Only user IDs
  in `AI_ROLLOUT_OWNER_USER_IDS` or `AI_TRAINING_ADMIN_USER_IDS` can call AI.
- Keep `CLOUDFLARE_LORA_ID` empty and `AI_LORA_RELEASE_STATUS=base` while using
  the base model.
- The API refuses to start with a LoRA unless an accepted dataset hash, adapter
  hash, and release-report hash are supplied. A percentage rollout above zero
  is additionally blocked until the owner-only production contract smoke test
  is marked passed.

## Render API

The root [`render.yaml`](../../render.yaml) pins the free plan, Node 22, pnpm,
the API build/start commands, `/api/healthz`, and checks-passing auto-deploys.
Connect that Blueprint to the `bbiolab123-cell/Integrated` repository and set
every `sync: false` value in the Bio Lab Render account:

- `DATABASE_URL`
- `CLERK_SECRET_KEY`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`
- `AI_ROLLOUT_OWNER_USER_IDS`
- `AI_TRAINING_ADMIN_USER_IDS`
- `AI_TRAINING_HASH_SECRET` (at least 32 random bytes)
- `ADMIN_EMAILS`

Do not add `CLOUDFLARE_LORA_ID` for iteration 11. Startup automatically creates
the additive AI feedback and persistent daily-quota tables before listening.
If the database cannot enforce the quota, AI requests fail with
`AI_QUOTA_UNAVAILABLE` instead of contacting the provider.

## Vercel frontend

The existing GitHub workflow builds and deploys the frontend after a push to
`main`. In the Bio Lab GitHub repository, configure `VERCEL_TOKEN`,
`VERCEL_ORG_ID`, and `VERCEL_PROJECT_ID` for the Bio Lab Vercel project. The
frontend build needs only public `VITE_*` values; provider credentials always
stay on Render.

Before raising rollout, confirm the Vercel app uses the expected Render API URL,
Clerk sign-in succeeds, CORS accepts only the production frontend, and all AI
contract tests pass for the owner account.

## Adapter promotion (future accepted iteration only)

1. Confirm the private release report says every gate passed.
2. Upload only `adapter_config.json` and `adapter_model.safetensors` to the
   approved Cloudflare LoRA endpoint.
3. Set the returned `CLOUDFLARE_LORA_ID`, set
   `AI_LORA_RELEASE_STATUS=accepted`, and copy the three exact SHA-256 values
   into the corresponding server-only variables.
4. Keep `AI_ROLLOUT_PERCENT=0` and
   `AI_LORA_PRODUCTION_SMOKE_STATUS=pending` while running all owner contract
   tests.
5. Only after those tests pass, set
   `AI_LORA_PRODUCTION_SMOKE_STATUS=passed`, then stage rollout at 10%, 50%, and
   100% with observation between stages.

Any failed gate means clearing the LoRA ID and returning to the base model.
