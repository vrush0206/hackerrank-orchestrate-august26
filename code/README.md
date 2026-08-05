# Message Notification Router

## Setup

Install dependencies with `npm ci`. Provide the Gemini key either in the shell:

```powershell
$env:GEMINI_API_KEY="your-key"
```

or copy `.env.example` to `.env` and replace the placeholder. `.env` is ignored by git and must never be committed.

The default model is the production-ready `gemini-3.6-flash`. Override it with `GEMINI_MODEL` only when needed.
Requests are spaced 15 seconds apart by default (four RPM), leaving buffer below a five-request-per-minute free-tier limit. A failed request is retried once, honoring Gemini's requested quota delay when present; a second failure aborts the run without writing a fallback row. Override these controls with `GEMINI_MIN_INTERVAL_MS` and `GEMINI_MAX_REQUEST_FAILURES`.

Production groups messages into batches of 10 by default, reducing 110 individual model calls to 11 structured calls while keeping batches sequential for RPM safety. Configure `MESSAGE_BATCH_SIZE`. For a real-data smoke run, set `MESSAGE_LIMIT=10`; leave it unset or `0` for the full dataset. Output validation automatically uses the same limit.

## Validate and test

Run `npm run typecheck` for an offline compilation check. Run `npm test` to compile and execute the lightweight two-message synthetic Gemini test; this does not read or modify the dataset.
Run `npm run test:offline` for no-API regression coverage of malformed batches, invalid evidence IDs, and missing media mappings.

## Production run

Run `npm start`, then open `http://localhost:3000`. This starts the UI5 React dashboard without calling Gemini. Use Data Overview for dataset insights, Run Control to initiate and monitor production, and Implementation Workflow to inspect the retrieval formula and prompt pipeline. Production processes `../dataset/messages.csv` and progressively writes a pending output before safely promoting `../dataset/output.csv`. The dashboard remains available for repeated guarded runs until you press `Ctrl+C`; use `npm run start:headless` when no dashboard is wanted.

After production completes, `npm start` automatically validates row counts, ID coverage, duplicates, confidence-zero rows, and the output schema. It then archives the generated CSV under the gitignored `run-output/` directory. Run `npm run validate:output` to repeat validation and archive the current output without calling the model.
