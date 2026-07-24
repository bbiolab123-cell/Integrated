# Adapter release gates

Evaluate the adapter against the unmodified Mistral base on the held-out `test`
split. Never use Gemini or ChatGPT output as the reference.

- Every structured protocol and Bioalyze response parses against its schema.
- Every quoted measurement exists in the supplied context; new calculations
  are explicitly marked as derived.
- No response exposes user identifiers, filenames, project names, or another
  user's experiments.
- At least 80% of held-out answers receive a scientist rating of 4/5 or better.
- The adapter's approval rate is at least 15 percentage points above the base.
- Streaming endpoints produce a first chunk within 10 seconds under normal
  network conditions and complete within the configured provider timeout.

Record the base and adapter ratings in a dated review note. If any gate fails,
leave `CLOUDFLARE_LORA_ID` empty, collect more corrected examples, and retrain.
