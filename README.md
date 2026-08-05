# Message Notification Router

A production-oriented TypeScript orchestration service that classifies incoming messages with Gemini and exposes run progress through a SAP UI5 React dashboard.

## What Was Built

- A typed relational data aggregator for user preferences, groups, businesses, media mappings, notification summaries, and historical interactions.
- Ranked historical-context retrieval using lexical similarity, recency, and interaction strength.
- Batched, rate-limited Gemini requests through the Vercel AI SDK.
- Multimodal image support using base64 content parts.
- Strict Zod validation for every routing decision.
- Progressive CSV output with safe promotion only after a successful run.
- Persistent error history, output validation, and local run archives.
- A responsive monitoring dashboard built with UI5 Web Components for React.

## Architecture

```text
dataset CSV files
       |
       v
DataAggregator indexes relational context
       |
       v
top-5 historical retrieval + preferences + channel metadata
       |
       v
batched multimodal Gemini request
       |
       v
Zod validation and message-ID correlation
       |
       v
output.pending.csv -> validation -> output.csv
```

Historical candidates are ranked with:

```text
score = 0.45 * lexical similarity
      + 0.30 * recency
      + 0.25 * interaction strength
```

Only the five highest-scoring channel-specific records are included in the LLM context to reduce prompt size and latency.

## UI5 Dashboard

Running the application starts a dashboard at `http://localhost:3000` with three areas:

- **Data Overview** displays indexed-record counts and input distributions without calling the model.
- **Run Control** starts a guarded run and shows progress, active model, RPM limit, decisions, confidence, and retained errors.
- **Implementation Workflow** explains aggregation, retrieval, enrichment, batching, and validation.

The interface uses UI5 `ShellBar`, `TabContainer`, `Card`, `ObjectStatus`, `ProgressIndicator`, `MessageStrip`, `List`, and icon components with SAP theme tokens.

## Project Structure

```text
code/
|-- dashboard-ui/          # React and UI5 dashboard
|-- src/
|   |-- aggregator.ts      # Typed CSV indexes and context lookup
|   |-- dashboard.ts       # Dashboard server and status API
|   |-- edge_case_test.ts  # Offline regression checks
|   |-- main.ts            # Production orchestration pipeline
|   |-- schema.ts          # Strict Zod decision schemas
|   |-- start.ts           # Dashboard-first application entry point
|   |-- test_runner.ts     # Lightweight model verification
|   |-- types.ts           # Dataset and routing types
|   `-- validate_output.ts # Output validation and archiving
|-- .env.example
|-- package.json
`-- tsconfig.json
```

## Setup

Requirements:

- Node.js 20 or newer
- A Gemini API key

```powershell
cd code
npm ci
Copy-Item .env.example .env
```

Add the key to `code/.env`:

```dotenv
GEMINI_API_KEY=your-key
```

The `.env` file, build artifacts, dependencies, error logs, and run archives are excluded from Git.

## Configuration

| Variable | Purpose | Default |
|---|---|---|
| `GEMINI_API_KEY` | Gemini authentication | Required |
| `GEMINI_MODEL` | Model override | `gemini-3.6-flash` |
| `MESSAGE_BATCH_SIZE` | Messages per model request | `10` |
| `MESSAGE_LIMIT` | Maximum messages for a smoke run; `0` means all | `0` |
| `GEMINI_MIN_INTERVAL_MS` | Minimum delay between requests | `15000` |
| `GEMINI_MAX_REQUEST_FAILURES` | Consecutive failures before stopping | `2` |

For a small real-data test, set `MESSAGE_LIMIT=10` before starting the run.

## Commands

Run compilation checks:

```powershell
npm run typecheck
```

Run offline edge-case tests without calling Gemini:

```powershell
npm run test:offline
```

Start the dashboard without immediately calling Gemini:

```powershell
npm start
```

Open `http://localhost:3000` and initiate the run from **Run Control**.

Run without the dashboard:

```powershell
npm run start:headless
```

Validate and archive an existing output without calling the model:

```powershell
npm run validate:output
```

## Output Safety

- Results are written progressively to `dataset/output.pending.csv`.
- The pending file is promoted to `dataset/output.csv` only after complete processing.
- Validation checks row counts, ID coverage, duplicate IDs, allowed schema values, and zero-confidence decisions.
- Failed requests are retained in the dashboard and written to a JSONL error log.
- Completed runs are archived under the Git-ignored `code/run-output/` directory.

Generated output files are intentionally kept separate from source commits unless they are explicitly selected for publication.
