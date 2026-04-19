# IDD Knowledge Chat — End-to-End Solution Architecture

Date: 2026-04-19
Status: Active
Scope: Current production behavior after Step 3 interaction hardening

## 1) System Purpose

IDD Knowledge Chat is a local-first retrieval-augmented generation system for operational document intelligence.

It provides:
- Conversational Q&A grounded in corpus evidence
- Strict source citation streaming in answers
- Document ingestion, reprocessing, and rebuild operations
- Retrieval quality controls for interaction-style questions
- Runtime model-tier selection (Fast vs Quality)

## 2) Runtime Topology

The deployed local topology is:

- Next.js app (UI + API routes)
- Local PostgreSQL with vector + text indexes
- LLM provider abstraction:
  - Anthropic path when `ANTHROPIC_API_KEY` is set
  - LM Studio OpenAI-compatible path otherwise

Primary API surfaces:
- `POST /api/chat` for streaming chat answers
- `POST /api/ingest` for ingest/reprocess/rebuild SSE operations
- `GET /api/docs` for ingest dashboard data

## 3) Core Architecture Layers

### 3.1 Presentation Layer

Chat UI:
- Model toggle: Fast/Quality
- Message streaming and source rendering
- Conversation history replay into backend context

Ingest UI:
- Health dashboard cards
- Document table with active/historical controls
- Ingest controls for new ingest, rebuild, single-doc reprocess, remove

### 3.2 API Orchestration Layer

`/api/chat` orchestrates:
1. Request validation and model tier intake
2. Query intent classification
3. Retrieval mode selection
4. Hybrid retrieval execution
5. Evidence formatting + source event emission
6. Model streaming generation
7. Interaction context persistence for follow-up chains

`/api/ingest` orchestrates:
1. Action validation
2. Optional rebuild clear-down
3. Ingestion execution with progress callbacks
4. SSE progress/error/done events

### 3.3 Retrieval and Reasoning Layer

Main retrieval modes:
- Standard
- Structural
- Synthesis list/rules
- Canonical lookup
- Interaction explanation

Interaction mode includes:
- Entity-pair extraction
- Tier classification of candidate chunks
  - Tier1: both entities
  - Tier2: mechanism-integrated
  - Tier3: supporting context
- Tier-aware ranking and caps
- Mechanism fallback behavior when mechanism evidence is weak

### 3.4 Data Layer

`documents` table stores:
- Active vs historical versions
- Extraction method/quality metadata
- Processing status and quality flags

`chunks` table stores:
- Chunk content and structure metadata
- Retrieval eligibility metadata
- Embeddings (for eligible searchable chunks)

## 4) Chat Request Flow (Detailed)

1. Client sends `question`, `conversationHistory`, `modelTier`.
2. API validates question and connectivity preflight.
3. Query intent is classified.
4. Retrieval mode is selected from intent.
5. For interaction flows:
   - Follow-up context can be inherited
   - Deep hint terms can be generated
   - Retrieval query may be expanded for continuity
6. Hybrid retrieval returns ranked chunks.
7. Sources are emitted first (`event: sources`).
8. Prompt is built by mode.
9. Streaming generation begins (`event: token`).
10. Interaction context marker is appended for future follow-ups.
11. Minimum citation floor is enforced if model omitted citations.

## 5) Ingestion Flow (Detailed)

1. Ingest action selected (`ingest_new`, `reprocess_one`, `full_rebuild`, `remove`).
2. SSE stream opens for long-running actions.
3. Extract/normalize/compose/embedding pipeline executes.
4. Progress events are emitted to dashboard.
5. Completion event returns ingest run summary.

Operational properties:
- Full rebuild requires explicit confirmation token
- Single-document reprocess is supported by source path lookup
- Remove action deactivates current document version

## 6) Model Selection Architecture

Model routing is two-dimensional:

- Provider selection:
  - Anthropic if `ANTHROPIC_API_KEY` is present
  - LM Studio otherwise

- Tier selection (user-driven in UI):
  - `default` tier (Fast)
  - `quality` tier (Quality)

Model IDs are resolved by env vars per provider and tier:
- Anthropic: `ANTHROPIC_DEFAULT_MODEL`, `ANTHROPIC_QUALITY_MODEL`
- LM Studio: `DEFAULT_ANSWER_MODEL`, `QUALITY_ANSWER_MODEL`

This gives operator-level provider switching and user-level quality switching without code changes.

## 7) Interaction Hardening Controls (Step 3)

The interaction subsystem enforces quality by design:

- Mechanism-aware routing and retrieval
- Tier distribution monitoring in live validation
- Source caps to prevent retrieval bloat
- Follow-up chain context continuity
- Explicit regression acceptance checks in broad validation

Final validation state at phase close:
- 50/50 query pass
- 0 failed queries
- All interaction acceptance checks true

## 8) Documentation and Memory Assets

Architecture and solution docs:
- `docs/specs/2026-04-16-idd-knowledge-chat-design.md`
- `docs/specs/2026-04-17-v2-data-quality-rebuild.md`
- `docs/specs/2026-04-19-solution-architecture.md` (this document)

Validation evidence:
- `docs/reports/2026-04-19-live-validation/chat-runtime-broad-coverage-step3-validation-final.json`

Repository memory note:
- `/memories/repo/solution-state.md`

These assets together describe system intent, implementation architecture, and operational proof.

## 9) What Is Guaranteed vs Configurable

Guaranteed (implemented behavior):
- Ingest operations and dashboard visibility
- Runtime model tier toggle in chat
- Provider routing by environment
- Streaming source-first chat response protocol
- Interaction guardrails and validation checks

Configurable (ops/runtime):
- Retrieval caps and thresholds via environment variables
- Model IDs by tier/provider
- Source path and ingest cadence

## 10) Practical Runbook

To operate safely:

1. Ensure database and model provider are reachable.
2. Use ingest dashboard to add/reprocess corpus updates.
3. Use Fast tier for routine questions; Quality tier for complex synthesis.
4. Run broad validation after major retrieval/prompt changes.
5. Verify acceptance checks remain green before banking a phase.
