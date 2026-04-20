# IDD Knowledge Chat

Local-first retrieval-augmented chat over operational documents, with ingestion tooling, evidence-first answers, and runtime model/provider controls.

## What You Get

- Chat answers grounded in corpus evidence with source citations
- Ingestion pipeline for adding/reprocessing documents
- Interaction-aware retrieval behavior for mechanism and cross-system questions
- Runtime model controls:
  - Tier: Fast (`default`) or Quality (`quality`)
  - Provider: Auto, Claude, or LM Studio
- Local PostgreSQL-backed corpus with migration scripts

## Tech Stack

- Next.js 16 + React 19
- TypeScript
- PostgreSQL + pgvector
- Anthropic SDK and OpenAI-compatible LM Studio routing

## Repository Layout

- `src/app` - Next.js app routes and API handlers
- `src/components` - chat and ingest UI
- `src/lib` - retrieval, generation, ingestion, and support modules
- `db/migrations` - SQL migrations
- `scripts` - operational scripts and validation runners
- `docs/specs` - design and architecture docs
- `docs/reports` - validation outputs

## Prerequisites

- Node.js 20+
- npm
- Docker (for local PostgreSQL via `docker compose`)
- One or both model backends:
  - Anthropic API key
  - LM Studio endpoint/model(s)

## Quick Start

1. Install dependencies:

```bash
npm install
```

2. Start database and apply migrations:

```bash
bash scripts/db-setup.sh
```

3. Set environment variables (example):

```bash
# Database + corpus
DATABASE_URL=postgres://damian:password@localhost:5432/idd_knowledge
SOURCE_PATH=/absolute/path/to/your-corpus

# Answer-generation routing mode
# lmstudio_only | anthropic_only | two_tier_auto
ANSWER_MODE=two_tier_auto

# Optional provider gating (default true when unset)
ANTHROPIC_ENABLED=true
CLAUDE_ENABLED=true

# Anthropic API key (either variable name works)
ANTHROPIC_API_KEY=<optional-if-using-claude>
CLAUDE_API_KEY=<optional-alias-if-using-claude>

# LM Studio endpoint
LMSTUDIO_URL=http://localhost:1234

# LM Studio model ids
DEFAULT_LMSTUDIO_MODEL=<lmstudio-fast-model>
QUALITY_LMSTUDIO_MODEL=<lmstudio-quality-model>

# Backward-compatible aliases still accepted
DEFAULT_ANSWER_MODEL=<legacy-lmstudio-fast-model>
QUALITY_ANSWER_MODEL=<legacy-lmstudio-quality-model>

# Anthropic model ids
ANTHROPIC_DEFAULT_MODEL=<anthropic-fast-model>
ANTHROPIC_QUALITY_MODEL=<anthropic-quality-model>
```

4. Run the app:

```bash
npm run dev
```

5. Open:

- Chat: `http://localhost:3000`
- Ingest dashboard: `http://localhost:3000/ingest`

## Answer Routing Modes

In chat UI:

- Tier toggle:
  - `Fast` -> `default`
  - `Quality` -> `quality`
- Answer mode selector:
  - `LM Studio only` -> always local model, no Claude escalation
  - `Claude only` -> always Anthropic model
  - `Auto (two-tier)` -> local by default, escalates to Claude for quality/low-confidence and synthesis-heavy questions
- Local model selector:
  - Populated from currently available LM Studio models (`GET /api/models`)
  - Disabled when answer mode is `Claude only`

`two_tier_auto` fallback behaviour when Claude is unavailable:

- Escalation falls back to LM Studio and emits routing diagnostics (`quality_mode_reason` includes `anthropic_unavailable_fallback_local`)

Request-level overrides are supported in `/api/chat` body:

```json
{
  "answerMode": "lmstudio_only",
  "lmStudioModel": "qwen3:8b"
}
```

## Ingestion Operations

From `/ingest`, available actions include:

- Ingest new/changed files
- Reprocess a single document
- Full corpus rebuild
- Remove (deactivate) current document version

Progress streams live via SSE and updates dashboard/table states.

### Ingesting into a different database/corpus

This app is already profile-driven:

- Database target is controlled by `DATABASE_URL`
- Default ingest corpus root is controlled by `SOURCE_PATH`

To switch to a different knowledge base:

1. Point `DATABASE_URL` to the new Postgres database.
2. Run migrations for that database.
3. Point `SOURCE_PATH` to the new content directory (or pass a one-off `sourcePath` in the `/api/ingest` request body).
4. Run `Full Rebuild` from `/ingest` to populate the new database.
5. Query in chat normally; retrieval will operate over the currently configured database.

#### Database switch runbook

Use this sequence when moving from one corpus database to another:

1. Stop app processes.
2. Set a new environment profile with the new DATABASE_URL and SOURCE_PATH.
3. Apply migrations to the new database.
4. Run a full rebuild ingest into that database.
5. Restart app and validate with a known query.

Example profile snippet:

```bash
DATABASE_URL=postgres://damian:password@localhost:5432/idd_knowledge_alt
SOURCE_PATH=/absolute/path/to/alternate-corpus
```

Migration + run flow:

```bash
# load your env profile first
bash scripts/db-setup.sh
npm run dev
```

Then open `/ingest` and run Full Rebuild once for the new corpus.

## Useful Scripts

- `npm run dev` - start development server
- `npm run build` - production build
- `npm run start` - run production server
- `npm run lint` - lint codebase
- `npm run test:core` - run core unit tests
- `npm run ci:core` - lint + core unit tests (same checks as CI)
- `npm run audit:pdf` - PDF completeness audit
- `npm run repair:section-titles` - repair section title quality
- `npm run rescue:pdf` - rescue active PDFs
- `npm run rescue:docs` - rescue active docs

Runtime validation:

```bash
npx tsx scripts/live-runtime-broad-coverage.ts --out report.json
```

## Validation and Documentation

- User manual: `docs/user-manual.md`
- Architecture: `docs/specs/2026-04-19-solution-architecture.md`
- Step 3 broad validation report:
  - `docs/reports/2026-04-19-live-validation/chat-runtime-broad-coverage-step3-validation-final.json`

## Notes

- Keep provider on `Auto` for day-to-day usage unless testing a specific backend.
- Prefer `Quality` tier for complex interaction/synthesis prompts.
- Re-run broad validation after major retrieval or prompt changes.

## Governance Helpers

Apply branch protection (required PR review + required CI check) with:

```bash
GITHUB_TOKEN=<repo-admin-token> bash scripts/enforce-branch-protection.sh
```
