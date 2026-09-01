# Bioalyzer readiness build plan

Implemented in launch order:

1. Keep-alive: public `/health` compatibility endpoint plus a 10-minute scheduled uptime ping.
2. Universal plate import: vendor-neutral XLSX/CSV/TSV/TXT detection for labeled, unlabeled, transposed, and long-form 96-well exports; manual 8×12 drag selection and control tagging when detection fails.
3. AI budget guard: shared UTC-day request and estimated-neuron ceilings, a 10% free-allocation reserve, no wasteful retry on provider quota exhaustion, and deterministic heatmap/CV%/Z′/IC50 functionality during AI outages.
4. Demo mode: a bundled, parsed sample dose-response plate seeded for the explicit local demo account.
5. Privacy: a public `/privacy` page in plain English, linked from signed-in and signed-out surfaces.
6. Backups: nightly encrypted `pg_dump` artifacts with checksums and a documented restore drill.
7. CV%: calculated by every successful universal plate import and shown as a first-class experiment metric.

Deliberately out of scope for this readiness pass: billing, teams, formal compliance claims, qPCR expansion, staging/alerting infrastructure, and production serving of an unaccepted LoRA adapter.
