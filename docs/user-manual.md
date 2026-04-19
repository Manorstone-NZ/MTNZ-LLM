# IDD Knowledge Chat — User Manual

Date: 2026-04-19
Audience: Operators and analysts using the local IDD Knowledge Chat system

## 1. What This System Does

IDD Knowledge Chat lets you:
- Ask questions over the IDD corpus and get evidence-grounded answers
- See source citations for answer traceability
- Ingest new documents and reprocess existing ones
- Choose answer quality tier (Fast/Quality)
- Choose model provider mode (Auto/Claude/LM Studio)

## 2. Prerequisites

You need:
- Local PostgreSQL running and configured for the project
- Next.js app running (`npm run dev`)
- Model runtime available:
  - LM Studio endpoint configured, and/or
  - Anthropic API key configured

Important env behavior:
- If `ANTHROPIC_API_KEY` is set, Claude provider is available
- If not, provider falls back to LM Studio

## 3. Starting the System

From project root:

```bash
npm run dev
```

Open the app in browser (typically `http://localhost:3000`).

## 4. Chat Usage

### 4.1 Asking questions

- Type your question in the chat input
- Press Enter (or click Send)
- You will receive streamed output and source citations

### 4.2 Model quality tier

Use the `Fast / Quality` toggle:
- `Fast` (`default` tier): lower latency, good for routine Q&A
- `Quality` (`quality` tier): higher quality synthesis, useful for complex interaction/rules questions

### 4.3 Model provider switch

Use the `Model Provider` selector:
- `Provider: Auto`:
  - Uses Claude when `ANTHROPIC_API_KEY` is available
  - Otherwise uses LM Studio
- `Provider: Claude`:
  - Forces Anthropic path when available
  - If unavailable, safely falls back to LM Studio
- `Provider: LM Studio`:
  - Forces local LM Studio path

## 5. Ingestion Usage

Open `/ingest` page in the app.

Available operations:
- `Ingest New`: scans source path for new/changed files
- `Reprocess One`: reprocess selected document
- `Full Rebuild`: clears corpus tables and re-ingests all documents
- `Remove`: deactivates current document version

Ingest operations stream progress events and refresh dashboard/table when complete.

### 5.1 Using a different database and different content set

To run the same app against another knowledge base:

1. Update `DATABASE_URL` to point to the target Postgres database.
2. Run migrations against that target database.
3. Set `SOURCE_PATH` to the target corpus directory.
4. Run `Full Rebuild` from `/ingest`.
5. Ask chat questions as normal; results come from the currently configured database.

Advanced option:
- `/api/ingest` accepts an optional `sourcePath` body field to override `SOURCE_PATH` for a specific ingest run.

## 6. Ingest Dashboard Interpretation

Top cards are scoped by active corpus unless explicitly marked historical.

Key metrics:
- Active docs/completed/pending/failed
- Quality tiers (`Good`, `Partial`, `Poor`, `Unclassified`)
- OCR used vs fallback extractions
- Historical versions and historical failed

Reconciliation expectation:
- `Good + Partial + Poor + Unclassified = Active Docs`

## 7. Document Table Controls

Default behavior:
- `Active only` enabled

Table capabilities:
- Filter by folder/status/type
- Toggle active-only scope
- View active/historical version badge per row
- Reprocess or remove documents from actions column

## 8. Operational Validation

For regression checks after major retrieval/prompt changes, run:

```bash
npx tsx scripts/live-runtime-broad-coverage.ts --out <report-name>.json
```

Primary reference report from current phase:
- `docs/reports/2026-04-19-live-validation/chat-runtime-broad-coverage-step3-validation-final.json`

This report should show:
- Full query set passing
- Interaction quality checks green

## 9. Troubleshooting

### 9.1 Chat returns provider/model errors

- If forcing `Provider: Claude`, verify `ANTHROPIC_API_KEY`
- If using LM Studio, verify endpoint and models are loaded
- Use `Provider: Auto` as safe default

### 9.2 Empty or weak answers

- Retry with `Quality` tier
- Verify ingest completed and active docs exist
- Check sources list for sparse retrieval evidence

### 9.3 Ingest failures

- Review error banner in `/ingest`
- Reprocess failed documents individually
- Use full rebuild only when necessary

## 10. Best Practices

- Keep provider on `Auto` for normal operations
- Keep one env profile per corpus/database pair to avoid accidental cross-ingest
- Use `Quality` for interaction-heavy and synthesis-heavy questions
- Validate after significant retrieval/prompt/ingest pipeline changes
- Keep architecture and validation docs up to date with each phase

## 11. Related Documentation

- Architecture: `docs/specs/2026-04-19-solution-architecture.md`
- Original design: `docs/specs/2026-04-16-idd-knowledge-chat-design.md`
- V2 quality rebuild: `docs/specs/2026-04-17-v2-data-quality-rebuild.md`
- Final Step 3 validation report: `docs/reports/2026-04-19-live-validation/chat-runtime-broad-coverage-step3-validation-final.json`
