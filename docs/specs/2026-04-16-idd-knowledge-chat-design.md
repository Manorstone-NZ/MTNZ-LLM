# IDD Knowledge Chat — Technical Specification

**Date:** 2026-04-16
**Status:** DRAFT
**Author:** Damian + Claude (AI specification partner)

---

## 1. Purpose

A local-first web application for conversational Q&A over the MTNZ LIMS IDD source document corpus. Users can ask natural-language questions about lab procedures, interview transcripts, equipment manuals, and supporting documents, and receive grounded answers constrained to retrieved source chunks, with strict source citations.

The tool also provides a document ingestion dashboard for managing the growing corpus.

## 2. Constraints

- **Fully local** — no cloud dependencies. No Supabase, no hosted APIs.
- **Sensitive content** — operational lab procedures, compliance data, personnel names.
- **Growing corpus** — currently 137 files / 140MB, will continue to grow.
- **Single user** — no auth required for v1.
- **Future portability** — design must migrate cleanly to hosted Postgres or Supabase later.

## 3. Architecture

```
Next.js app (localhost:3000)
├── Chat UI          — ask questions, see cited answers
├── Ingestion UI     — manage documents, view health, trigger reprocessing
└── API routes       — chat, ingest, docs

Local PostgreSQL (localhost:5432)
├── documents table
├── chunks table
├── pgvector extension   — vector similarity search
├── tsvector indexes     — full-text search
└── pg_trgm extension    — fuzzy/trigram matching

LM Studio (localhost:1234)
├── text-embedding-nomic-embed-text-v1.5  — embeddings (768d)
├── qwen3.5-9b                            — fast answers, query rewrite
└── gpt-oss-20b                           — high-quality grounded answers
```

## 4. Source Documents

Location: `/Users/damian/Projects/Claude Cowork/IDD/Project Data/Transcripts`

| Folder | Count | Type | Content |
|--------|-------|------|---------|
| LOP | 62 | PDF | Laboratory Operating Procedures |
| EOP | 23 | PDF | Equipment Operating Procedures |
| Recordings | 12 | DOCX | Interview transcripts |
| Supporting | ~38 | PDF, XLSX, TXT, images | Data models, test registries, regulatory docs, manuals |
| Architecture | 1 | DOCX | MADCAP functional decomposition |

File types: 107 PDF, 17 DOCX, 7 XLSX, 3 TXT, 1 PNG, 1 JPG.

## 5. Extraction Pipeline

### 5.1 PDF extraction

1. Attempt text extraction (pdf-parse or pdfjs-dist)
2. If extracted text is empty or below a character threshold → flag as image/scanned
3. Scanned PDFs → OCR via Tesseract (tesseract.js or system Tesseract) as a **fallback only**
4. OCR output must be marked in metadata (`ocr_used: true`, `ocr_confidence` if available)
5. Low-confidence OCR documents are surfaced in the ingestion UI for manual review
6. If OCR fails → mark `extraction_status: failed` with error message

### 5.2 DOCX extraction

- Use mammoth.js — preserves heading hierarchy, tables, lists, numbered steps
- Extract heading structure for section titles
- Preserve table markup for structure-aware chunking

### 5.3 XLSX extraction

- Use xlsx (SheetJS) library
- Extract per-sheet with full metadata:
  - Sheet name
  - Detected table boundaries (header rows, blank-row separators)
  - Column headers
  - Range references
  - Formula presence flags
  - Merged cell handling

### 5.4 TXT extraction

- Direct read, detect paragraph boundaries via blank lines

### 5.5 Images (PNG, JPG)

- Skip for v1. Flag in inventory as `extraction_status: skipped_unsupported`.

## 6. Chunking Strategy

### 6.1 Prose documents (PDF, DOCX, TXT)

1. Parse into structural units: headings, sections, paragraphs, tables, numbered lists, revision blocks, appendices, acceptance criteria
2. Keep tables and numbered step sequences as atomic units — never split mid-table or mid-procedure
3. Merge adjacent small units up to a **600–1,000 token ceiling**
4. Apply **100–150 token overlap only at artificial splits** (where a section exceeds the ceiling and must be broken)
5. Each chunk carries its structural context:
   - Section title / heading hierarchy
   - Page number
   - Document title
   - Citation label (e.g. "LOP-MC 001 V1, Section 3.2")

### 6.2 Spreadsheets (XLSX)

Separate strategy — not treated as prose:

1. Chunk by sheet
2. Within each sheet, detect table boundaries
3. Chunk by logical table/range, then by row groups if a table is large
4. Each chunk stores:
   - Sheet name
   - Column headers (repeated per chunk for retrieval coherence)
   - Range reference
   - Row range
   - Formula presence flag
5. Flatten to text with headers prepended

### 6.3 Token counting

Use tiktoken (cl100k_base) for consistent token counting across chunks.

## 7. Embedding

- Model: `text-embedding-nomic-embed-text-v1.5` via LM Studio
- Endpoint: `POST http://localhost:1234/v1/embeddings`
- Dimensions: 768
- Input: chunk content text
- Batch embedding during ingestion (batch size configurable, default 32)

## 8. PostgreSQL Schema

### 8.1 Extensions

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;     -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS vector;       -- pgvector
CREATE EXTENSION IF NOT EXISTS pg_trgm;      -- trigram matching
```

### 8.2 documents table

```sql
CREATE TABLE documents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title           TEXT NOT NULL,
  filename        TEXT NOT NULL,
  source_path     TEXT NOT NULL,         -- relative path within Transcripts/
  folder          TEXT NOT NULL,         -- EOP, LOP, Recordings, Supporting, Architecture
  source_type     TEXT NOT NULL,         -- pdf, docx, xlsx, txt
  version_hash    TEXT NOT NULL,         -- SHA-256 of file content
  is_active       BOOLEAN NOT NULL DEFAULT true,
  superseded_at   TIMESTAMPTZ,
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  document_date   DATE,                  -- if detectable from content
  chunk_count     INTEGER NOT NULL DEFAULT 0,
  extraction_status TEXT NOT NULL DEFAULT 'pending',
    -- pending | extracting | chunking | embedding | storing | completed | failed | skipped_unchanged | skipped_unsupported
  extraction_error TEXT,
  ocr_used        BOOLEAN NOT NULL DEFAULT false,
  ocr_confidence  NUMERIC,               -- rough confidence if available
  source_missing  BOOLEAN NOT NULL DEFAULT false,  -- true if file not found on last scan
  processed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  search_text     TSVECTOR,              -- document-level FTS (title, folder, filename)
  title_normalized TEXT                   -- lowercase, no punctuation, for search
);

CREATE INDEX idx_documents_active ON documents (is_active) WHERE is_active = true;
CREATE INDEX idx_documents_folder ON documents (folder);
CREATE INDEX idx_documents_hash ON documents (version_hash);

-- Enforce one active version per source path
CREATE UNIQUE INDEX ux_documents_active_source_path
  ON documents (source_path) WHERE is_active = true;

-- Document-level full-text search
CREATE INDEX idx_documents_search_text ON documents USING gin (search_text);
```

### 8.3 chunks table

```sql
CREATE TABLE chunks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id     UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  content         TEXT NOT NULL,
  content_preview TEXT NOT NULL,          -- first 200 chars
  search_text     TSVECTOR NOT NULL,      -- for full-text search
  embedding       VECTOR(768) NOT NULL,
  chunk_index     INTEGER NOT NULL,       -- order within document
  chunk_hash      TEXT NOT NULL,           -- for dedup
  token_count     INTEGER NOT NULL,
  page_number     INTEGER,                -- null for XLSX
  section_title   TEXT,                    -- heading hierarchy
  sheet_name      TEXT,                    -- XLSX only
  range_ref       TEXT,                    -- XLSX only
  citation_label  TEXT NOT NULL,           -- human-readable source ref
  metadata        JSONB DEFAULT '{}',      -- extensible (column headers, formula flags, etc.)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Vector similarity search index
-- NOTE: ivfflat performs properly only after sufficient data exists and after
-- running ANALYZE chunks. For small corpora (<1000 chunks), exact cosine search
-- may be acceptable. ivfflat is retained for scale growth but should be reviewed
-- after initial performance testing. Tune `lists` parameter based on corpus size.
CREATE INDEX idx_chunks_embedding ON chunks
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- Full-text search index
CREATE INDEX idx_chunks_search_text ON chunks USING gin (search_text);

-- Trigram index on content for fuzzy matching
-- NOTE: Review whether trigram should be shifted to citation_label,
-- section_title, and document title fields if index size or write cost
-- becomes high. A denormalised searchable label field may be more efficient.
CREATE INDEX idx_chunks_content_trgm ON chunks USING gin (content gin_trgm_ops);

-- Trigram indexes on structured label fields (lightweight, high-value)
CREATE INDEX idx_chunks_citation_trgm ON chunks USING gin (citation_label gin_trgm_ops);
CREATE INDEX idx_chunks_section_trgm ON chunks USING gin (section_title gin_trgm_ops)
  WHERE section_title IS NOT NULL;

-- Filter by active documents only
CREATE INDEX idx_chunks_document_id ON chunks (document_id);

-- Enforce unique chunk ordering within a document
CREATE UNIQUE INDEX ux_chunks_document_chunk_index
  ON chunks (document_id, chunk_index);

-- Prevent duplicate chunk content within a document
CREATE UNIQUE INDEX ux_chunks_document_chunk_hash
  ON chunks (document_id, chunk_hash);
```

### 8.4 ingest_runs table

```sql
CREATE TABLE ingest_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'running',
    -- running | completed | failed | cancelled
  scanned_count   INTEGER NOT NULL DEFAULT 0,
  processed_count INTEGER NOT NULL DEFAULT 0,
  failed_count    INTEGER NOT NULL DEFAULT 0,
  skipped_count   INTEGER NOT NULL DEFAULT 0,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 8.5 search_text generation

The `search_text` TSVECTOR column on chunks is generated **application-side** during insert/update, not via DB trigger. This keeps the logic explicit and testable.

The tsvector is built from a weighted concatenation of:

```sql
setweight(to_tsvector('english', coalesce(citation_label, '')), 'A') ||
setweight(to_tsvector('english', coalesce(section_title, '')), 'A') ||
setweight(to_tsvector('english', coalesce(sheet_name, '')), 'B') ||
setweight(to_tsvector('english', coalesce(metadata->>'column_headers', '')), 'B') ||
setweight(to_tsvector('english', content), 'C')
```

Weight A fields (citation_label, section_title) are boosted because users frequently search by procedure name or section. Weight C (content) provides broad coverage.

The `documents.search_text` field is similarly built from:

```sql
setweight(to_tsvector('english', title), 'A') ||
setweight(to_tsvector('english', filename), 'A') ||
setweight(to_tsvector('english', folder), 'B')
```

This supports document-first retrieval queries like "show me the manual for X".

## 9. Retrieval Pipeline

### 9.1 Query flow

```
User question
    │
    ├─ 1. Optional query rewrite (qwen3.5-9b)
    │     Expand acronyms, clarify intent, preserve exact terms
    │
    ├─ 2. Embed rewritten query (nomic-embed-text-v1.5)
    │
    ├─ 3a. Vector search ──────────────────────────────┐
    │       SELECT ... ORDER BY embedding <=> $query    │
    │       LIMIT 25                                    │
    │       WHERE document is_active = true             │
    │                                                   ├─ 5. Merge candidates
    ├─ 3b. Full-text search ───────────────────────────┤      Deduplicate by chunk_id
    │       ts_rank(search_text, plainto_tsquery($q))   │
    │       LIMIT 25                                    │
    │                                                   │
    ├─ 3c. Trigram search ─────────────────────────────┘
    │       similarity(content, $q) for exact terms
    │       LIMIT 25
    │
    ├─ 6. Score fusion
    │     Normalize vector similarity, FTS rank, trigram score
    │     Weighted combination (tunable)
    │
    ├─ 7. Select top 6–10 chunks
    │
    └─ 8. Send to answer model with structured source context
```

### 9.2 Score fusion (v1)

```
final_score = (w_vec * norm_vector_score)
            + (w_fts * norm_fts_score)
            + (w_trgm * norm_trigram_score)
```

Default weights: `w_vec = 0.5, w_fts = 0.3, w_trgm = 0.2`. Tunable via config.

### 9.3 Active document filter

All retrieval queries include `JOIN documents ON chunks.document_id = documents.id WHERE documents.is_active = true`. Only active (non-superseded) documents are searched.

## 10. Answer Generation

### 10.1 Model selection

| Model | Use case | Latency |
|-------|----------|---------|
| qwen3.5-9b | Fast answers, query rewrite, citation validation | Low |
| gpt-oss-20b | High-quality synthesis, multi-document reasoning, procedural questions | Higher |

Default: configurable via `DEFAULT_ANSWER_MODEL` env var. User can toggle models in the UI.

`DEFAULT_ANSWER_MODEL` and `QUALITY_ANSWER_MODEL` are configuration values pointing to model IDs as registered in LM Studio. The examples shown (qwen3.5-9b, gpt-oss-20b) are current local model IDs. The application must not assume fixed canonical model names in code — model IDs are read from configuration at runtime.

### 10.2 Prompt structure

Each request to the answer model includes:

```
System prompt:
- You are an IDD knowledge assistant for the MTNZ LIMS replacement programme.
- Answer ONLY from the provided source chunks. Do not use prior knowledge.
- Cite every substantive claim using [Source: citation_label].
- If evidence is incomplete, say so explicitly.
- If sources conflict, present both with their citations.
- Never stitch across documents without making the cross-reference explicit.

Context chunks (structured):
[
  {
    "chunk_id": "c_0042",
    "citation_label": "LOP-MC 001 V1, Section 3.2",
    "doc_title": "LOP-MC 001 (V1) MADCAP Procedures Manual",
    "folder": "LOP",
    "page": 14,
    "section_title": "Sample Selection Priority",
    "content": "..."
  },
  ...
]

Conversation history (for coherence, not retrieval):
[prior messages in this session]

User question:
"..."
```

### 10.3 Citation enforcement

- The system prompt mandates `[Source: citation_label]` syntax
- Only citation_labels from the provided chunks are valid
- Optional: post-generation citation validation pass with the fast answer model to check that cited labels match provided chunks

### 10.4 Chat failure handling

- **LM Studio unavailable** → return clear error in UI: "Answer model is not available. Check that LM Studio is running."
- **Retrieval yields no relevant chunks** → return: "No grounded evidence found in the document corpus for this question."
- **Answer model returns malformed citations** → optionally retry once with a stricter prompt
- **Only weak retrieval evidence exists** (low scores across all candidates) → return cautious answer with explicit uncertainty: "The following answer is based on limited evidence..."
- **Embedding endpoint unavailable** → return clear error; do not fall back to FTS-only silently without informing the user

## 11. Session Management

- Conversation history kept **in-memory per session** (not persisted)
- Retrieval uses **latest question only** — conversation history is NOT passed to the retrieval pipeline
- Session state object tracks:
  - Current topic
  - Cited document IDs (for "show me more from this document" follow-ups)
  - Follow-up context
- Each browser tab is an independent session
- Session IDs are client-generated and held in browser memory only for v1

## 12. Document Versioning

### 12.1 Ingest lifecycle

1. Scan source directory
2. For each file, compute SHA-256 hash
3. **Unchanged** (hash matches active document) → `skipped_unchanged`, update `last_seen_at`
4. **Changed** (hash differs from active document) → deactivate prior version (`is_active: false`, `superseded_at: now()`), insert new document + chunks
5. **New** (no prior record) → insert document + chunks
6. **Deleted from filesystem** (active document not found in scan) → set `source_missing: true`, keep `is_active: true` until user decides. Surface clearly in ingestion UI with distinct visual treatment.

### 12.2 Version queries

- Default: answer from active versions only
- Future: "show me what changed between versions" (not v1)

## 13. Ingestion UI

### 13.1 Document inventory view

Table showing all documents with columns:
- Title, folder, type, status, chunk count, last processed, is_active

Filters: by folder, by status, by type.

### 13.2 Controls

- **Ingest new/changed** — scan directory, process only new or changed files
- **Reprocess single document** — force re-extraction and re-chunking of one document
- **Remove from index** — deactivate a document and its chunks
- **Full rebuild** — drop all chunks and documents, re-ingest everything

### 13.3 Health dashboard

- Total documents (active / inactive / failed)
- Total chunks
- Documents with zero extracted text
- Average chunks per document
- Last ingest run timestamp
- Embedding model in use
- Database size

## 14. Project Structure

```
idd-knowledge-chat/
├── src/
│   ├── app/                        # Next.js App Router
│   │   ├── page.tsx                # Chat UI
│   │   ├── ingest/page.tsx         # Ingestion dashboard
│   │   ├── layout.tsx
│   │   └── api/
│   │       ├── chat/route.ts       # Query pipeline
│   │       ├── ingest/route.ts     # Ingestion triggers
│   │       └── docs/route.ts       # Document inventory + health
│   ├── lib/
│   │   ├── db.ts                   # PostgreSQL client (pg or postgres.js)
│   │   ├── embeddings.ts           # LM Studio embeddings client
│   │   ├── generation.ts           # LM Studio generation client (model selection)
│   │   ├── retrieval.ts            # Hybrid search + score fusion
│   │   ├── citations.ts            # Citation formatting + validation
│   │   ├── chunking/
│   │   │   ├── prose.ts            # Structure-aware chunker for PDF/DOCX/TXT
│   │   │   └── spreadsheet.ts      # Sheet-aware chunker for XLSX
│   │   ├── extraction/
│   │   │   ├── pdf.ts              # PDF text extraction + OCR fallback
│   │   │   ├── docx.ts             # DOCX with heading/table preservation
│   │   │   ├── xlsx.ts             # Spreadsheet with rich metadata
│   │   │   └── txt.ts              # Plain text
│   │   └── repositories/
│   │       ├── documents.ts        # Document CRUD + versioning logic
│   │       └── chunks.ts           # Chunk CRUD + search queries
│   └── components/
│       ├── chat/                   # Chat interface components
│       └── ingest/                 # Ingestion dashboard components
├── db/
│   └── migrations/
│       └── 001_initial_schema.sql  # Tables, indexes, extensions
├── scripts/
│   └── ingest.ts                   # CLI ingestion script (can also run headless)
├── package.json
├── tsconfig.json
├── next.config.ts
└── .env.local                      # DB connection, LM Studio URL, source path
```

## 15. Configuration (.env.local)

```env
# PostgreSQL (include user for local trust auth)
DATABASE_URL=postgresql://damian@localhost:5432/idd_knowledge

# LM Studio
LMSTUDIO_URL=http://localhost:1234
EMBEDDING_MODEL=text-embedding-nomic-embed-text-v1.5
DEFAULT_ANSWER_MODEL=qwen3.5-9b
QUALITY_ANSWER_MODEL=gpt-oss-20b

# Source documents
SOURCE_PATH=/Users/damian/Projects/Claude Cowork/IDD/Project Data/Transcripts

# Retrieval tuning
VECTOR_WEIGHT=0.5
FTS_WEIGHT=0.3
TRIGRAM_WEIGHT=0.2
TOP_K_CANDIDATES=25
TOP_K_FINAL=8
```

## 16. Dependencies

### Runtime
- next (App Router)
- react, react-dom
- postgres (or pg) — PostgreSQL client
- pgvector — vector type support for the client
- pdf-parse or pdfjs-dist — PDF text extraction
- tesseract.js — OCR fallback
- mammoth — DOCX extraction
- xlsx (SheetJS) — spreadsheet extraction
- tiktoken — token counting
- openai — LM Studio client (OpenAI-compatible API)

### Dev
- typescript
- tailwindcss
- eslint

## 17. Future Migration Path

| Phase | Stack |
|-------|-------|
| v1 (now) | Local Postgres + LM Studio |
| v2 | Self-hosted or managed Supabase / hosted Postgres |
| v3 | Add auth, remote access, shared document spaces |

The schema and retrieval logic are standard PostgreSQL and are designed to migrate with minimal application changes. In most cases the migration should be limited to infrastructure, connection configuration, and operational plumbing rather than core retrieval logic.

## 18. Key Risks

### 18.1 Extraction quality, not retrieval, will decide usefulness

The retrieval design is solid. The real risk is poor extraction from scanned PDFs, messy DOCX structure, spreadsheets with odd layouts, and manuals with tables and diagrams. Extraction QA is a first-class workstream — the ingestion health dashboard and OCR flagging exist specifically to surface these problems early.

### 18.2 Prompt discipline

If the answer model is allowed too much freedom, it will over-synthesise. The citation rules and grounding constraints are good, but they need testing with real documents. **Grounded refusal is a success condition, not a failure condition.** If the evidence is weak, the model should say so. This must be validated during acceptance testing.

## 19. Out of Scope for v1

- IDD template population (next step after this tool is working)
- Persistent chat history
- Multi-user auth
- Version diff ("what changed between versions")
- Image/diagram extraction from PDFs
- Local reranker model (score fusion is sufficient for v1)
- Claude API integration (fully local models only)
