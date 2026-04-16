# IDD Knowledge Chat — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local-first RAG web app for conversational Q&A over the MTNZ LIMS IDD source document corpus (137+ files), with hybrid retrieval, strict citation grounding, and a document ingestion dashboard.

**Architecture:** Next.js App Router frontend with chat and ingestion UIs. Local PostgreSQL (Docker) with pgvector + pg_trgm for hybrid retrieval. LM Studio serving embeddings (nomic-embed-text-v1.5) and answer generation (configurable models). Structure-aware document chunking with separate strategies for prose and spreadsheets.

**Tech Stack:** Next.js 15, TypeScript, Tailwind CSS, PostgreSQL 16 (Docker, pgvector/pgvector:pg16), pgvector, pg_trgm, LM Studio (OpenAI-compatible API), pdf-parse, mammoth, xlsx, tiktoken, openai (client), react-markdown, remark-gfm, tesseract.js (deferred)

**Spec:** `docs/specs/2026-04-16-idd-knowledge-chat-design.md`

---

## Environment State (Known)

| Dependency | Status |
|---|---|
| Node.js v24.14.0 | Present |
| npm 11.9.0 / npx | Present |
| Docker | Installed |
| PostgreSQL | Not installed locally — will run via Docker |
| Tesseract | Not confirmed — OCR deferred, feature-flagged off |
| LM Studio | Running on localhost:1234, nomic-embed-text-v1.5 confirmed |

---

## Shared Interfaces

These interfaces must be agreed before Phase 2 agents begin. They are defined in Task 3 and referenced by all extractors and chunkers.

```typescript
// === src/lib/types.ts ===

// Extraction output — common across all extractors
export interface ExtractedContent {
  text: string;
  sections: ExtractedSection[];
  metadata: Record<string, unknown>;
  ocr_used?: boolean;
  ocr_confidence?: number;
}

export interface ExtractedSection {
  title: string | null;
  content: string;
  page?: number;
  level?: number;         // heading depth
  type: 'heading' | 'paragraph' | 'table' | 'list' | 'revision_block' | 'appendix';
}

// Chunk output — common across all chunkers
export interface PreparedChunk {
  content: string;
  content_preview: string;    // first 200 chars
  chunk_index: number;
  chunk_hash: string;         // SHA-256 of content
  token_count: number;
  page_number: number | null;
  section_title: string | null;
  sheet_name: string | null;
  range_ref: string | null;
  citation_label: string;
  metadata: Record<string, unknown>;
}

// Retrieval result
export interface ScoredChunk {
  id: string;
  document_id: string;
  content: string;
  content_preview: string;
  citation_label: string;
  section_title: string | null;
  sheet_name: string | null;
  page_number: number | null;
  doc_title: string;
  folder: string;
  score: number;              // normalised fusion score
  vector_score?: number;
  fts_score?: number;
  trigram_score?: number;
}

// SSE event types for chat streaming
export type ChatSSEEvent =
  | { event: 'token'; data: { text: string } }
  | { event: 'sources'; data: { chunks: CitedChunk[] } }
  | { event: 'done'; data: { ok: true } }
  | { event: 'error'; data: { message: string; code: string } };

export interface CitedChunk {
  chunk_id: string;
  citation_label: string;
  doc_title: string;
  folder: string;
  page: number | null;
  section_title: string | null;
  sheet_name: string | null;
  content_preview: string;
}
```

---

## Configuration (.env.local)

```env
# PostgreSQL (Docker container)
DATABASE_URL=postgresql://damian:localdev@localhost:5432/idd_knowledge

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
MIN_GROUNDED_SCORE=0.18
LOW_CONFIDENCE_SCORE=0.30

# Ingestion
INGEST_FILE_CONCURRENCY=2
EMBED_BATCH_SIZE=32
OCR_ENABLED=false
```

---

## Phase 1: Foundation (sequential — each task blocks the next)

### Task 1: PostgreSQL via Docker + schema

**Files:**
- Create: `docker-compose.yml`
- Create: `db/migrations/001_initial_schema.sql`
- Create: `scripts/db-setup.sh`

- [ ] **Step 1: Create docker-compose.yml**

```yaml
version: '3.8'
services:
  db:
    image: pgvector/pgvector:pg16
    container_name: idd-knowledge-db
    ports:
      - "5432:5432"
    environment:
      POSTGRES_DB: idd_knowledge
      POSTGRES_USER: damian
      POSTGRES_PASSWORD: localdev
    volumes:
      - pgdata:/var/lib/postgresql/data
    restart: unless-stopped

volumes:
  pgdata:
```

Note: `pgvector/pgvector:pg16` ships with pgvector pre-installed. pg_trgm and pgcrypto are included in standard PostgreSQL. Do NOT mount migrations into `docker-entrypoint-initdb.d` — migrations are run explicitly via the setup script to avoid double execution.

- [ ] **Step 2: Create 001_initial_schema.sql**

Single migration file. Extensions first, then tables, then indexes. Copy verbatim from spec sections 8.1–8.4:

```sql
-- Extensions (must be first — schema depends on these)
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- documents table (spec 8.2)
CREATE TABLE documents ( ... );
-- All document indexes including ux_documents_active_source_path

-- chunks table (spec 8.3)
CREATE TABLE chunks ( ... );
-- All chunk indexes including ux_chunks_document_chunk_index, ux_chunks_document_chunk_hash
-- ivfflat index with comment: for small corpora, exact cosine scan may be acceptable

-- ingest_runs table (spec 8.4)
CREATE TABLE ingest_runs ( ... );
```

- [ ] **Step 3: Create scripts/db-setup.sh**

```bash
#!/bin/bash
set -e
echo "Starting PostgreSQL..."
docker compose up -d
echo "Waiting for PostgreSQL to be ready..."
until docker exec idd-knowledge-db pg_isready -U damian; do sleep 1; done
echo "PostgreSQL is ready."
echo "Running migrations..."
for f in db/migrations/*.sql; do
  echo "  Applying $f..."
  docker exec -i idd-knowledge-db psql -U damian -d idd_knowledge < "$f"
done
echo "Done."
```

- [ ] **Step 4: Run setup and verify**

```bash
chmod +x scripts/db-setup.sh && ./scripts/db-setup.sh
```

Verify extensions:
```bash
docker exec idd-knowledge-db psql -U damian -d idd_knowledge -c "SELECT extname FROM pg_extension;"
```

Expected: pgcrypto, vector, pg_trgm all present.

Verify tables:
```bash
docker exec idd-knowledge-db psql -U damian -d idd_knowledge -c "\dt"
```

Expected: documents, chunks, ingest_runs.

- [ ] **Step 5: Commit**

```bash
git init && git add docker-compose.yml db/ scripts/db-setup.sh
git commit -m "feat: PostgreSQL via Docker with pgvector schema"
```

**Acceptance criteria:**
- Docker container starts and stays running
- All 3 extensions installed
- All 3 tables created with correct columns
- Unique constraints prevent duplicate active source paths
- Unique constraints prevent duplicate chunk indexes per document

---

### Task 2: Next.js project scaffold + dependencies

**Files:**
- Create: `package.json` (via create-next-app)
- Create: `.env.local`
- Create: `src/app/layout.tsx`
- Create: `src/app/page.tsx` (placeholder)

- [ ] **Step 1: Scaffold Next.js app**

Note: existing files (docker-compose.yml, db/, docs/, scripts/) must survive. If create-next-app conflicts with existing files, scaffold into a temp directory and merge deliberately.

```bash
npx create-next-app@latest . --typescript --tailwind --eslint --app --src-dir --no-import-alias --no-turbopack
```

If this fails due to existing files, scaffold into `/tmp/idd-scaffold` and copy `src/`, `package.json`, `tsconfig.json`, `next.config.ts`, `tailwind.config.ts`, `postcss.config.mjs` into the project root.

- [ ] **Step 2: Install runtime dependencies**

```bash
npm install postgres pgvector pdf-parse mammoth xlsx tiktoken openai react-markdown remark-gfm
```

- [ ] **Step 3: Install dev dependencies**

```bash
npm install -D @types/pdf-parse tsx
```

Note: `tsx` is required for running `scripts/ingest.ts` via `npx tsx`.

- [ ] **Step 4: Create .env.local**

Use the Configuration block from above. Add `.env.local` to `.gitignore`.

- [ ] **Step 5: Verify dev server starts**

```bash
npm run dev
```

Expected: Next.js starts on localhost:3000 with default page.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: Next.js scaffold with dependencies"
```

**Acceptance criteria:**
- `npm run dev` starts without errors
- All runtime and dev dependencies installed
- .env.local exists and is gitignored

---

### Task 3: Shared types, DB client, repository layer

**Files:**
- Create: `src/lib/types.ts`
- Create: `src/lib/db.ts`
- Create: `src/lib/repositories/documents.ts`
- Create: `src/lib/repositories/chunks.ts`

- [ ] **Step 1: Create src/lib/types.ts**

Copy the Shared Interfaces block from above (ExtractedContent, ExtractedSection, PreparedChunk, ScoredChunk, ChatSSEEvent, CitedChunk).

- [ ] **Step 2: Create src/lib/db.ts**

```typescript
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
});

export default sql;
```

- [ ] **Step 3: Create src/lib/repositories/documents.ts**

Implements:
- `createDocument(doc)` — insert with SQL-side search_text generation
- `findActiveBySourcePath(sourcePath)` — lookup for version comparison
- `deactivateDocument(id)` — set is_active=false, superseded_at=now()
- `markSourceMissing(id)` — set source_missing=true
- `updateExtractionStatus(id, status, error?)` — state machine transitions
- `updateChunkCount(id, count)` — after chunking completes
- `getDocumentInventory(filters?)` — list with filtering by folder, status, type
- `getHealthMetrics()` — aggregate stats for dashboard

**Important:** search_text and title_normalized are computed SQL-side in the INSERT/UPDATE statement, not in TypeScript:

```sql
INSERT INTO documents (title, filename, source_path, folder, source_type, version_hash, search_text, title_normalized)
VALUES ($1, $2, $3, $4, $5, $6,
  setweight(to_tsvector('english', $1), 'A') ||
  setweight(to_tsvector('english', $2), 'A') ||
  setweight(to_tsvector('english', $4), 'B'),
  lower(regexp_replace($1, '[^a-zA-Z0-9 ]', '', 'g'))
)
RETURNING *;
```

- [ ] **Step 4: Create src/lib/repositories/chunks.ts**

Implements:
- `insertChunks(documentId, chunks: PreparedChunk[])` — bulk insert with SQL-side search_text
- `deleteChunksByDocumentId(documentId)` — for reprocessing
- `vectorSearch(embedding, limit)` — cosine similarity, joined to active documents
- `fullTextSearch(query, limit)` — ts_rank with plainto_tsquery, joined to active documents
- `trigramSearch(query, limit)` — similarity() on content, citation_label, coalesce(section_title, ''), joined to active documents

**Important:** chunk search_text is computed SQL-side:

```sql
INSERT INTO chunks (document_id, content, content_preview, search_text, embedding, ...)
VALUES ($1, $2, $3,
  setweight(to_tsvector('english', coalesce($citation_label, '')), 'A') ||
  setweight(to_tsvector('english', coalesce($section_title, '')), 'A') ||
  setweight(to_tsvector('english', coalesce($sheet_name, '')), 'B') ||
  setweight(to_tsvector('english', coalesce($column_headers, '')), 'B') ||
  setweight(to_tsvector('english', $content), 'C'),
  $embedding, ...)
```

Trigram queries must use `coalesce` for nullable fields:

```sql
greatest(
  similarity(content, $1),
  similarity(citation_label, $1),
  similarity(coalesce(section_title, ''), $1)
) as trgm_score
```

- [ ] **Step 5: Verify DB connection**

```bash
npx tsx -e "import sql from './src/lib/db'; const r = await sql\`SELECT 1 as ok\`; console.log(r); process.exit(0);"
```

Expected: `[{ ok: 1 }]`

- [ ] **Step 6: Commit**

```bash
git add src/lib/types.ts src/lib/db.ts src/lib/repositories/
git commit -m "feat: shared types, DB client, and repository layer"
```

**Acceptance criteria:**
- DB connection pool works against Docker container
- search_text is computed in SQL, not TypeScript
- All repository methods use parameterised queries (no SQL injection)
- Active document filter applied in all search queries

---

### Task 4: LM Studio clients (embeddings + generation)

**Files:**
- Create: `src/lib/embeddings.ts`
- Create: `src/lib/generation.ts`

- [ ] **Step 1: Create src/lib/embeddings.ts**

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: process.env.LMSTUDIO_URL! + '/v1',
  apiKey: 'lm-studio',
});

export async function embedText(text: string): Promise<number[]> {
  const response = await client.embeddings.create({
    model: process.env.EMBEDDING_MODEL!,
    input: text,
  });
  return response.data[0].embedding;
}

export async function embedBatch(
  texts: string[],
  batchSize = parseInt(process.env.EMBED_BATCH_SIZE || '32')
): Promise<number[][]> {
  const results: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const response = await client.embeddings.create({
      model: process.env.EMBEDDING_MODEL!,
      input: batch,
    });
    results.push(...response.data.map(d => d.embedding));
  }
  return results;
}
```

- [ ] **Step 2: Create src/lib/generation.ts**

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: process.env.LMSTUDIO_URL! + '/v1',
  apiKey: 'lm-studio',
});

export type ModelTier = 'default' | 'quality';

function getModelId(tier: ModelTier): string {
  return tier === 'quality'
    ? process.env.QUALITY_ANSWER_MODEL!
    : process.env.DEFAULT_ANSWER_MODEL!;
}

export async function generateStream(
  systemPrompt: string,
  userMessage: string,
  conversationHistory: { role: 'user' | 'assistant'; content: string }[],
  tier: ModelTier = 'default'
): Promise<AsyncIterable<string>> {
  // Returns async iterable of text chunks
  // Wraps OpenAI streaming response
  // If streaming fails, retry once non-streaming and yield full text
}

export async function generateSync(
  systemPrompt: string,
  userMessage: string,
  tier: ModelTier = 'default'
): Promise<string> {
  // Non-streaming completion for query rewrite / validation passes
}
```

Streaming fallback: if the stream call throws, retry once with `stream: false` and return the full text. This avoids brittle chat UX when a model doesn't support streaming cleanly.

- [ ] **Step 3: Verify embeddings client**

```bash
npx tsx -e "
import { embedText } from './src/lib/embeddings';
const v = await embedText('milk testing laboratory');
console.log('Dimensions:', v.length);
console.log('First 3:', v.slice(0, 3));
process.exit(0);
"
```

Expected: `Dimensions: 768`

- [ ] **Step 4: Commit**

```bash
git add src/lib/embeddings.ts src/lib/generation.ts
git commit -m "feat: LM Studio clients for embeddings and generation"
```

**Acceptance criteria:**
- embedText returns 768-dimensional vector
- embedBatch processes arrays in configurable batch sizes
- generateStream returns async iterable of text chunks
- Streaming fallback works if stream mode fails
- Model IDs read from env vars, not hardcoded

---

## Phase 2: Extraction + Chunking (parallelisable with constraints)

**Dependency note:** Tasks 5, 6, and 7 (extractors) can run in parallel — they are independent and share only the `ExtractedContent`/`ExtractedSection` interfaces defined in `src/lib/types.ts`.

Task 8 (chunkers) consumes extractor output. It can begin once interfaces are locked (they are, in Task 3), but should be validated against real extractor output before declaring complete. In practice, start Task 8 in parallel but run its final test step after at least one extractor is done.

### Task 5: PDF extraction

**Files:**
- Create: `src/lib/extraction/pdf.ts`

- [ ] **Step 1: Implement text extraction with pdf-parse**

Parse PDF buffer, extract text with page boundaries. Map each page's text into raw blocks.

- [ ] **Step 2: Implement OCR detection**

After text extraction, check: if total extracted characters < 100 (configurable threshold), flag as scanned/image PDF.

- [ ] **Step 3: Implement OCR path (feature-flagged)**

Check `OCR_ENABLED` env var:
- If `false` and PDF is scanned → return `{ extraction_status: 'failed', extraction_error: 'Scanned PDF requires OCR. OCR_ENABLED=false.' }`
- If `true` → attempt tesseract.js, set `ocr_used: true`, `ocr_confidence` if available
- If OCR fails → return extraction error

- [ ] **Step 4: Implement section detection**

Parse extracted text into `ExtractedSection[]` by detecting:
- Lines matching heading patterns (all caps, numbered sections like "3.2 Procedure")
- Page breaks
- Table-like content (rows of aligned/tabular data)
- Numbered step sequences (1. 2. 3. or a) b) c))

Each section gets a `type` ('heading', 'paragraph', 'table', 'list') and `page` number.

- [ ] **Step 5: Test with a real LOP PDF**

Extract one file from `Transcripts/LOP/`. Inspect section count, types, page numbers. Verify tables detected as atomic units.

- [ ] **Step 6: Commit**

```bash
git add src/lib/extraction/pdf.ts
git commit -m "feat: PDF extraction with section detection and OCR fallback"
```

**Acceptance criteria:**
- Text PDFs produce sections with page numbers
- Scanned PDFs with OCR_ENABLED=false produce clear error
- Table-like content detected as type 'table'
- Numbered steps detected as type 'list'
- Output conforms to ExtractedContent interface

---

### Task 6: DOCX extraction

**Files:**
- Create: `src/lib/extraction/docx.ts`

- [ ] **Step 1: Implement DOCX extraction with mammoth**

Convert DOCX to structured HTML via mammoth. Parse the HTML to extract headings (h1-h6), paragraphs, tables, and lists into `ExtractedSection[]`.

Do not flatten to plain text — preserve the heading/table/list structure.

- [ ] **Step 2: Implement heading hierarchy tracking**

Track heading nesting: if a paragraph follows an h2 under an h1, its `section_title` should be `"H1 Title > H2 Title"`.

- [ ] **Step 3: Implement table preservation**

Tables → atomic `ExtractedSection` with type `'table'`. Format content as pipe-delimited rows with header row.

- [ ] **Step 4: Test with a real interview transcript DOCX**

Extract one file from `Transcripts/Recordings/`. Verify heading hierarchy, section count.

- [ ] **Step 5: Commit**

```bash
git add src/lib/extraction/docx.ts
git commit -m "feat: DOCX extraction with heading hierarchy and table preservation"
```

**Acceptance criteria:**
- Heading hierarchy tracked as "Parent > Child" in section_title
- Tables preserved as atomic sections
- Lists preserved as atomic sections
- Output conforms to ExtractedContent interface

---

### Task 7: XLSX extraction

**Files:**
- Create: `src/lib/extraction/xlsx.ts`

- [ ] **Step 1: Implement sheet-level extraction**

Use xlsx (SheetJS). For each sheet, extract: sheet name, used range, column headers (first row), merged cell boundaries, formula presence.

- [ ] **Step 2: Implement table boundary detection**

Within each sheet, detect logical table groups separated by blank rows. Each group becomes an `ExtractedSection` with type `'table'`.

Metadata per section: `{ column_headers, range_ref, row_count, formula_present, sheet_name }`.

- [ ] **Step 3: Implement text flattening with context**

Flatten each table group:
```
Sheet: [sheet_name]
Columns: Col1 | Col2 | Col3
---
Row 1 val | Row 1 val | Row 1 val
Row 2 val | Row 2 val | Row 2 val
```

Column headers repeated per section for retrieval coherence.

- [ ] **Step 4: Test with a real XLSX from Supporting**

Extract one file from `Transcripts/Supporting/`. Verify sheet separation, column headers captured, table boundaries detected.

- [ ] **Step 5: Commit**

```bash
git add src/lib/extraction/xlsx.ts
git commit -m "feat: XLSX extraction with sheet-aware table detection"
```

**Acceptance criteria:**
- Each sheet produces separate sections
- Column headers captured in metadata
- Table boundaries detected via blank-row separators
- Merged cells handled without crashing
- Output conforms to ExtractedContent interface

---

### Task 8: TXT extraction + prose chunker + spreadsheet chunker

**Files:**
- Create: `src/lib/extraction/txt.ts`
- Create: `src/lib/chunking/prose.ts`
- Create: `src/lib/chunking/spreadsheet.ts`

- [ ] **Step 1: Create TXT extractor**

Read file, split on blank lines into paragraph sections. Each paragraph → `ExtractedSection` with type `'paragraph'`.

- [ ] **Step 2: Create prose chunker**

Input: `ExtractedSection[]` + document metadata (title, filename).
Output: `PreparedChunk[]`.

Logic:
1. Walk sections in order
2. Tables and lists (numbered step sequences) → kept as atomic chunks (never split)
3. Adjacent small sections → merge up to 600–1,000 token ceiling (use tiktoken cl100k_base)
4. Sections exceeding ceiling → split at sentence boundaries, apply 100–150 token overlap at artificial splits only
5. Each chunk gets:
   - `section_title` from nearest heading ancestor
   - `page_number` from source section
   - `citation_label`: `"{doc_title}, {section_title}"` or `"{doc_title}, p.{page}"`
   - `chunk_hash`: SHA-256 of content
   - `content_preview`: first 200 chars
   - `token_count`: from tiktoken

- [ ] **Step 3: Create spreadsheet chunker**

Input: `ExtractedSection[]` from XLSX extraction + document metadata.
Output: `PreparedChunk[]`.

Logic:
1. Each sheet-level section is a candidate chunk
2. If a table group exceeds 1,000 tokens → split by row groups, keep column headers per chunk
3. Each chunk gets:
   - `sheet_name`, `range_ref` from source
   - `citation_label`: `"{doc_title}, Sheet: {sheet_name}, {range_ref}"`
   - `metadata.column_headers`, `metadata.formula_present`

- [ ] **Step 4: Test chunkers with real extractor output**

Run prose chunker on output from Tasks 5 or 6. Run spreadsheet chunker on output from Task 7.

Verify:
- No chunk exceeds 1,000 tokens
- Tables and lists are never split
- Overlap only at artificial splits
- citation_labels are human-readable

- [ ] **Step 5: Commit**

```bash
git add src/lib/extraction/txt.ts src/lib/chunking/
git commit -m "feat: TXT extraction, prose chunker, spreadsheet chunker"
```

**Acceptance criteria:**
- No chunk exceeds 1,000 tokens
- Tables and numbered-step lists are always atomic
- Overlap only applied at artificial splits (100–150 tokens)
- citation_labels follow the pattern "{doc_title}, {section/page}"
- chunk_hash is SHA-256 of content
- Token counts computed via tiktoken cl100k_base

---

## Phase 3: Ingestion Pipeline (sequential — depends on Phase 2)

### Task 9: Ingestion orchestrator

**Files:**
- Create: `src/lib/ingestion.ts`
- Create: `scripts/ingest.ts`

- [ ] **Step 1: Create src/lib/ingestion.ts**

Core pipeline implementing spec section 12.1:

```typescript
export async function ingestDocuments(options: {
  sourcePath: string;
  forceReprocess?: boolean;
  singleFile?: string;
}): Promise<IngestRunResult>
```

**Run locking:** Check for existing ingest_run with status `'running'`. If found, refuse to start (return error). Only one ingest run at a time.

**File scanning:**
- Recursively scan sourcePath
- Skip dotfiles (`.DS_Store`, etc.)
- Skip temp Office files (`~$*.docx`)
- Skip unsupported extensions → log and count as skipped
- Track: scanned, processed, failed, skipped counts

**Per-file pipeline:**
1. Compute SHA-256 of file content
2. Check against active document for this source_path
3. Route:
   - **Unchanged** (hash matches) → `skipped_unchanged`, update `last_seen_at`
   - **New** (no active document) → full pipeline
   - **Changed** (hash differs) → full pipeline, then deactivate old version (see below)
4. Full pipeline: update status through `extracting → chunking → embedding → storing → completed`
5. Route by extension: `.pdf` → pdf extractor → prose chunker, `.docx` → docx → prose, `.xlsx` → xlsx → spreadsheet, `.txt` → txt → prose, `.png`/`.jpg` → `skipped_unsupported`
6. If failed at any stage → record error, continue to next file

**Changed document safety:**
1. Insert new document row
2. Insert new chunks
3. Only THEN deactivate old document row (`is_active: false, superseded_at: now()`)

This ensures a failed re-ingest never leaves you with no active version.

**Source-missing detection:**
After processing all files, query active documents whose `source_path` was not seen in the scan. Set `source_missing: true` on those.

**Concurrency:** Process files with concurrency limit from `INGEST_FILE_CONCURRENCY` env var (default 2).

**Embedding batching:** Embed chunks in batches of `EMBED_BATCH_SIZE` (default 32).

- [ ] **Step 2: Create scripts/ingest.ts — CLI entrypoint**

```typescript
// Run: npx tsx scripts/ingest.ts [--force] [--file <path>]
```

Loads .env.local, parses args, calls `ingestDocuments()`, prints summary.

- [ ] **Step 3: Run initial ingestion on full Transcripts folder**

```bash
npx tsx scripts/ingest.ts
```

Monitor progress. Expect some PDFs to fail (scanned, OCR disabled). Log all failures.

- [ ] **Step 4: Verify data in PostgreSQL**

```bash
docker exec idd-knowledge-db psql -U damian -d idd_knowledge -c "
  SELECT extraction_status, count(*) FROM documents GROUP BY extraction_status ORDER BY count DESC;
  SELECT count(*) as total_chunks FROM chunks;
  SELECT avg(chunk_count)::int as avg_chunks_per_doc FROM documents WHERE extraction_status = 'completed';
"
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/ingestion.ts scripts/ingest.ts
git commit -m "feat: ingestion pipeline with lifecycle management and run locking"
```

**Acceptance criteria:**
- Run lock prevents concurrent ingestion
- Dotfiles, temp files, unsupported types skipped with logged reasons
- Changed documents: new version inserted before old deactivated
- source_missing correctly flagged for deleted files
- File concurrency respects INGEST_FILE_CONCURRENCY
- Embedding batched per EMBED_BATCH_SIZE
- ingest_runs table populated with accurate counts

---

## Phase 4: Retrieval + Answer Generation (sequential — depends on Phase 3)

### Task 10: Hybrid retrieval with score fusion

**Files:**
- Create: `src/lib/retrieval.ts`

- [ ] **Step 1: Implement vector search**

```typescript
export async function vectorSearch(queryEmbedding: number[], limit: number): Promise<ScoredChunk[]>
```

SQL joins chunks to documents, filters `is_active = true`, orders by `embedding <=> $1`.

Score = `1 - (embedding <=> $1)` (converts distance to similarity).

- [ ] **Step 2: Implement full-text search**

```typescript
export async function fullTextSearch(query: string, limit: number): Promise<ScoredChunk[]>
```

Uses `ts_rank(search_text, plainto_tsquery('english', $1))`. Filters `search_text @@ plainto_tsquery(...)` and `is_active = true`.

- [ ] **Step 3: Implement trigram search**

```typescript
export async function trigramSearch(query: string, limit: number): Promise<ScoredChunk[]>
```

Score = `greatest(similarity(content, $1), similarity(citation_label, $1), similarity(coalesce(section_title, ''), $1))`.

Filter with `content % $1 OR citation_label % $1 OR coalesce(section_title, '') % $1`.

Uses `coalesce` for nullable fields.

- [ ] **Step 4: Implement score normalization and fusion**

**Normalization method (min-max per result set):**
- For each retrieval mode's result set, compute min and max scores
- Normalize: `(score - min) / (max - min)` → [0, 1]
- If only one result or all same score → score = 1.0
- Missing score in a modality (chunk not returned by that search) → 0

**Fusion:**
```typescript
export async function hybridSearch(query: string): Promise<ScoredChunk[]> {
  const queryEmbedding = await embedText(query);
  const topK = parseInt(process.env.TOP_K_CANDIDATES || '25');
  const finalK = parseInt(process.env.TOP_K_FINAL || '8');
  const wVec = parseFloat(process.env.VECTOR_WEIGHT || '0.5');
  const wFts = parseFloat(process.env.FTS_WEIGHT || '0.3');
  const wTrgm = parseFloat(process.env.TRIGRAM_WEIGHT || '0.2');

  const [vecResults, ftsResults, trgResults] = await Promise.all([
    vectorSearch(queryEmbedding, topK),
    fullTextSearch(query, topK),
    trigramSearch(query, topK),
  ]);

  // Min-max normalize each set
  // Merge by chunk ID, sum weighted scores
  // Sort descending, return top finalK
}
```

- [ ] **Step 5: Test retrieval with known queries**

Test against ingested corpus:
- "MADCAP sample selection" → expect Scott/Gavin transcript chunks and LOP-MC 001
- "LOP-MC 001" → expect exact match via trigram/FTS on citation_label
- "M. bovis procedure" → expect LOP-AH 002 chunks
- "CRV vial washing" → expect LOP-CR 001 chunks

Verify: all three search modes contribute results, duplicates merged, inactive docs excluded.

- [ ] **Step 6: Commit**

```bash
git add src/lib/retrieval.ts
git commit -m "feat: hybrid retrieval with vector + FTS + trigram score fusion"
```

**Acceptance criteria:**
- Query returns combined results from all three retrieval modes
- Duplicate chunk IDs merged correctly (best score kept per mode)
- Final result count respects TOP_K_FINAL
- Inactive documents never appear in results
- Score normalization is min-max per result set
- Missing modality scores default to 0

---

### Task 11: Citation formatting + answer prompt

**Files:**
- Create: `src/lib/citations.ts`
- Create: `src/lib/prompts.ts`

- [ ] **Step 1: Create src/lib/citations.ts**

```typescript
export function formatChunksForPrompt(chunks: ScoredChunk[]): CitedChunk[]
// Transform retrieval results into CitedChunk format for the answer prompt

export function validateCitations(answer: string, providedLabels: string[]): {
  valid: string[];
  invalid: string[];
}
// Extract [Source: ...] patterns from answer text
// Check each against providedLabels
```

- [ ] **Step 2: Create src/lib/prompts.ts**

```typescript
export const SYSTEM_PROMPT = `You are an IDD knowledge assistant for the MTNZ LIMS replacement programme.
- Answer ONLY from the provided source chunks. Do not use prior knowledge.
- Cite every substantive claim using [Source: citation_label].
- If evidence is incomplete, say so explicitly.
- If sources conflict, present both with their citations.
- Never stitch across documents without making the cross-reference explicit.
- If the provided chunks do not contain sufficient evidence to answer, say: "No grounded evidence found for this question."`;

export function buildAnswerMessage(question: string, chunks: CitedChunk[]): string {
  const chunkContext = JSON.stringify(chunks, null, 2);
  return `## Retrieved Source Chunks\n\n${chunkContext}\n\n## Question\n\n${question}`;
}
```

Note: query rewrite is deferred for v1. Embed and search the original query directly. Add rewrite after first retrieval quality assessment.

- [ ] **Step 3: Commit**

```bash
git add src/lib/citations.ts src/lib/prompts.ts
git commit -m "feat: citation formatting, validation, and answer prompt"
```

**Acceptance criteria:**
- formatChunksForPrompt produces valid CitedChunk[] from ScoredChunk[]
- validateCitations correctly identifies valid and invalid [Source: ...] references
- System prompt enforces grounded-only answers

---

## Phase 5: API Routes (parallelisable — Tasks 12, 13, 14 are independent)

### Task 12: Chat API route

**Files:**
- Create: `src/app/api/chat/route.ts`

- [ ] **Step 1: Implement POST /api/chat**

Request body:
```typescript
{
  question: string;
  conversationHistory: { role: 'user' | 'assistant'; content: string }[];
  modelTier?: 'default' | 'quality';
}
```

Pipeline:
1. Check LM Studio availability (quick health check) → 503 if down
2. Embed question → 503 if embedding endpoint down (do NOT silently fall back to FTS-only)
3. Run `hybridSearch(question)` → chunks with scores
4. If no chunks or all scores below `MIN_GROUNDED_SCORE` → return SSE with "No grounded evidence found" message
5. If best score below `LOW_CONFIDENCE_SCORE` → prepend uncertainty caveat to prompt
6. Format chunks → build answer message → stream response

- [ ] **Step 2: Implement SSE streaming format**

Use Server-Sent Events with typed events:

```
event: sources
data: {"chunks": [...CitedChunk objects...]}

event: token
data: {"text": "The "}

event: token
data: {"text": "MADCAP "}

event: token
data: {"text": "system..."}

event: done
data: {"ok": true}
```

On error:
```
event: error
data: {"message": "Answer model is not available. Check that LM Studio is running.", "code": "LM_UNAVAILABLE"}
```

Sources are sent FIRST (before tokens) so the UI can render source cards immediately.

- [ ] **Step 3: Test with curl**

```bash
curl -N -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"question": "What is the MADCAP sample selection process?"}'
```

Verify: SSE events stream correctly.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/chat/route.ts
git commit -m "feat: chat API route with SSE streaming and error handling"
```

**Acceptance criteria:**
- Sources sent before tokens in SSE stream
- LM Studio down → 503 with error event
- No chunks → "no evidence" message (not an error)
- Low confidence → uncertainty caveat prepended
- Embedding endpoint down → clear error, no silent FTS fallback

---

### Task 13: Ingestion API route

**Files:**
- Create: `src/app/api/ingest/route.ts`

- [ ] **Step 1: Implement POST /api/ingest**

Request body:
```typescript
{
  action: 'ingest_new' | 'reprocess_one' | 'remove' | 'full_rebuild';
  documentId?: string;       // required for reprocess_one, remove
  confirm?: string;          // required for full_rebuild: must be "REBUILD"
}
```

Actions:
- `ingest_new` → `ingestDocuments({ sourcePath, forceReprocess: false })`
- `reprocess_one` → `ingestDocuments({ sourcePath, forceReprocess: true, singleFile: <path from documentId> })`
- `remove` → set `is_active: false` on document (soft deactivate, not hard delete). Optionally set `metadata.manually_removed: true`
- `full_rebuild` → requires `confirm: "REBUILD"`, returns 400 without it. Deletes all documents and chunks, runs full ingest. Returns 409 if an ingest is already running.

**Run lock:** All actions that trigger ingestion check for running ingest_run first. Return 409 if one exists.

- [ ] **Step 2: Implement streaming progress**

For long-running actions (ingest_new, full_rebuild), stream SSE progress events per document:

```
event: progress
data: {"file": "LOP/LOP-MC 001.pdf", "status": "completed", "processed": 5, "total": 137}
```

- [ ] **Step 3: Commit**

```bash
git add src/app/api/ingest/route.ts
git commit -m "feat: ingestion API with action dispatch and safety guards"
```

**Acceptance criteria:**
- full_rebuild requires confirm: "REBUILD" payload
- 409 returned if ingest already running
- remove is soft deactivation, not hard delete
- Progress streamed as SSE events

---

### Task 14: Documents API route

**Files:**
- Create: `src/app/api/docs/route.ts`

- [ ] **Step 1: Implement GET /api/docs**

Query params: `folder`, `status`, `type` for filtering.

Returns:
```typescript
{
  documents: DocumentRow[];
  health: {
    total_active: number;
    total_inactive: number;
    total_failed: number;
    total_chunks: number;
    zero_text_docs: number;
    avg_chunks_per_doc: number;
    last_ingest_run: string | null;
    embedding_model: string;
    db_size_mb: number;
    source_missing_count: number;
    ocr_used_count: number;
  };
}
```

DB size via: `SELECT pg_database_size('idd_knowledge')`.

- [ ] **Step 2: Commit**

```bash
git add src/app/api/docs/route.ts
git commit -m "feat: document inventory and health API"
```

**Acceptance criteria:**
- Filters work for folder, status, type
- Health metrics are accurate against actual DB state
- source_missing_count reflects documents with source_missing=true

---

## Phase 6: Frontend (parallelisable — Tasks 15 and 16 are independent)

### Task 15: Chat UI

**Files:**
- Modify: `src/app/page.tsx` (replace scaffold placeholder)
- Modify: `src/app/layout.tsx` (add navigation)
- Create: `src/components/chat/ChatContainer.tsx`
- Create: `src/components/chat/MessageBubble.tsx`
- Create: `src/components/chat/SourceCard.tsx`
- Create: `src/components/chat/ModelToggle.tsx`

- [ ] **Step 1: Create ChatContainer**

- Text input with send button at bottom
- Scrollable message area above
- Model toggle (default/quality) in header
- Session state in React state: messages[], citedDocs[], sessionId (crypto.randomUUID())
- Fetches /api/chat with streaming EventSource/fetch reader

- [ ] **Step 2: Create MessageBubble**

- User messages: right-aligned
- Assistant messages: left-aligned, rendered via `react-markdown` with `remark-gfm`
- Parse `[Source: ...]` patterns into clickable badges linking to SourceCard
- Streaming: renders incrementally as SSE token events arrive

- [ ] **Step 3: Create SourceCard**

- Shows citation_label, doc_title, folder as compact card
- Expandable to show content_preview
- Rendered from `sources` SSE event data

- [ ] **Step 4: Create ModelToggle**

Simple toggle in header showing current model name. Sends `modelTier` with each /api/chat request.

- [ ] **Step 5: Wire up streaming SSE consumption**

Use `fetch` with `getReader()` to consume SSE stream. Parse events:
- `sources` → populate SourceCard array
- `token` → append to current message
- `done` → mark message complete
- `error` → show error banner

- [ ] **Step 6: Implement failure states**

- LM Studio down → error banner with message from error event
- No results → show "no evidence" message cleanly (not an error state)
- Loading → typing indicator

- [ ] **Step 7: Add navigation in layout.tsx**

Simple nav bar with links to `/` (Chat) and `/ingest` (Dashboard).

- [ ] **Step 8: Test end-to-end in browser**

Open localhost:3000, ask questions, verify streaming answers with citations appear. Test model toggle. Test error states.

- [ ] **Step 9: Commit**

```bash
git add src/app/page.tsx src/app/layout.tsx src/components/chat/
git commit -m "feat: chat UI with streaming, citations, and model toggle"
```

**Acceptance criteria:**
- Messages stream incrementally (not all at once)
- Source cards appear before the answer text starts streaming
- [Source: ...] patterns render as clickable badges
- Model toggle switches between default and quality
- Error states shown clearly in UI
- Markdown renders correctly (tables, lists, code blocks)

---

### Task 16: Ingestion dashboard UI

**Files:**
- Create: `src/app/ingest/page.tsx`
- Create: `src/components/ingest/DocumentTable.tsx`
- Create: `src/components/ingest/HealthDashboard.tsx`
- Create: `src/components/ingest/IngestControls.tsx`

- [ ] **Step 1: Create HealthDashboard**

Metric cards showing: total active/inactive/failed docs, total chunks, zero-text docs, avg chunks/doc, last ingest timestamp, embedding model, DB size, source-missing count, OCR-used count.

Fetches from `GET /api/docs`.

- [ ] **Step 2: Create DocumentTable**

Sortable, filterable table with columns: title, folder, type, status, chunk_count, processed_at, is_active, source_missing.

Visual treatment:
- `source_missing: true` → amber warning row
- `extraction_status: 'failed'` → red row
- `ocr_used: true` → OCR badge on row

Filters: dropdown for folder, status, type.

- [ ] **Step 3: Create IngestControls**

Buttons:
- "Ingest New/Changed" → POST /api/ingest `{action: "ingest_new"}`
- "Full Rebuild" → POST /api/ingest `{action: "full_rebuild", confirm: "REBUILD"}` with confirmation dialog
- Per-row: "Reprocess" → POST /api/ingest `{action: "reprocess_one", documentId: ...}`
- Per-row: "Remove" → POST /api/ingest `{action: "remove", documentId: ...}`

Show streaming progress during ingestion (consume SSE progress events).

- [ ] **Step 4: Wire up and refresh on actions**

Fetch health + documents on page load. Refresh after ingestion actions complete.

- [ ] **Step 5: Test end-to-end in browser**

Open localhost:3000/ingest. Verify:
- Health metrics display and match DB state
- Document list loads with correct data
- Filters work
- Failed docs shown in red, missing source in amber
- Ingest New/Changed triggers ingestion with progress feedback

- [ ] **Step 6: Commit**

```bash
git add src/app/ingest/ src/components/ingest/
git commit -m "feat: ingestion dashboard with health metrics, document table, and controls"
```

**Acceptance criteria:**
- Health metrics accurate against DB
- Document table filterable by folder, status, type
- Failed docs red, missing-source amber, OCR flagged
- Full Rebuild requires confirmation dialog
- Progress shown during ingestion

---

## Phase 7: Integration Testing + Polish (sequential)

### Task 17: End-to-end verification

**Files:**
- No new files — testing and fixing existing system

- [ ] **Step 1: Verify full ingest**

Run `npx tsx scripts/ingest.ts` if not already done. Record total docs, chunks, failures.

Compare: dashboard health metrics match CLI output.

- [ ] **Step 2: Test 10 representative queries**

| # | Query | Expected behaviour |
|---|-------|--------------------|
| 1 | "LOP-MC 001" | Exact match via FTS/trigram on citation_label |
| 2 | "Mycoplasma bovis testing procedure" | LOP-AH 002 chunks, cited |
| 3 | "What did Gavin say about selection rules?" | Scott/Gavin transcript chunks |
| 4 | "BactoScan configuration" | EOP and LOP chunks about BactoScan |
| 5 | "Which procedures mention IANZ accreditation?" | Cross-document synthesis with multiple citations |
| 6 | "MADCAP test type 300" | Spreadsheet-sourced chunk if XLSX ingested |
| 7 | "What is the CEO's birthday?" | Grounded refusal: "No grounded evidence found" |
| 8 | "deprecated chemical process" | Weak/no evidence → uncertainty caveat |
| 9 | Follow-up: "Tell me more about that" (after Q2) | Uses conversation context, not re-retrieval |
| 10 | "Show me the CRV vial washing manual" | Document-first result from LOP-CR 001 |

For each: verify answer is grounded, citations are valid against provided chunks, failure modes work correctly.

- [ ] **Step 3: Review extraction failures**

In the ingestion dashboard:
- How many docs failed?
- How many are scanned PDFs needing OCR?
- Any source_missing flags?
- Any zero-text docs that should have content?

Log findings. Fix extraction issues if straightforward.

- [ ] **Step 4: Test ingestion controls**

- Reprocess one document → verify new chunks replace old
- Remove one document → verify it disappears from search results
- Verify run lock: trigger ingest, then immediately try again → expect 409

- [ ] **Step 5: Commit any fixes**

```bash
git add -A && git commit -m "fix: integration test fixes from end-to-end verification"
```

**Acceptance criteria:**
- At least 80% of source documents successfully ingested
- All 10 test queries produce correct behaviour
- Grounded refusal works for out-of-scope questions
- Ingestion controls work correctly
- Dashboard metrics match DB state

---

## Parallelism Map

```
Phase 1: [Task 1] → [Task 2] → [Task 3] → [Task 4]   (sequential — foundation)

Phase 2: [Task 5]  ─┐
         [Task 6]  ──┤  (parallel — independent extractors)
         [Task 7]  ──┤
         [Task 8]  ─┘  (parallel start, validate against extractor output before completing)

Phase 3: [Task 9]                                       (sequential — needs Phase 2)

Phase 4: [Task 10] → [Task 11]                          (sequential)

Phase 5: [Task 12] ─┐
         [Task 13] ──┤  (parallel — independent API routes)
         [Task 14] ─┘

Phase 6: [Task 15] ─┐   (parallel — independent UI pages)
         [Task 16] ─┘

Phase 7: [Task 17]                                       (sequential — final verification)
```

**Subagent dispatch strategy:**
- Phase 1: one agent, sequential (each task depends on prior)
- Phase 2: 4 parallel agents (Tasks 5, 6, 7, 8) — interfaces locked in Task 3
- Phase 3: one agent after Phase 2 completes
- Phase 4: one agent (sequential tasks)
- Phase 5: 3 parallel agents (one per API route)
- Phase 6: 2 parallel agents (chat UI + ingest UI)
- Phase 7: one agent for final verification

**Total: up to 9 concurrent agents across 4 parallel dispatch waves.**
