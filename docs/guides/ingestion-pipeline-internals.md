# Ingestion Pipeline Internals

**Audience:** Developers and technical architects

**Purpose:** Comprehensive reference for the V2 three-stage ingestion pipeline and all validation/processing rules

---

## Architecture Overview

The ingestion system follows a **three-stage pipeline** designed for data quality, traceability, and efficient retrieval:

```
Stage 1: EXTRACT          Stage 2: NORMALIZE        Stage 3: COMPOSE & EMBED
┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐
│ File routing by type │  │ Text standardization │  │ Semantic chunking    │
│ Native extraction    │  │ Boilerplate removal  │  │ Quality assessment   │
│ OCR fallback         │  │ Structural analysis  │  │ Vector embedding     │
│ Quality scoring      │  │ Sanity validation    │  │ Metadata tagging     │
│ Metadata capture     │  │ Fingerprint tracking │  │ Storage & indexing   │
└──────────────────────┘  └──────────────────────┘  └──────────────────────┘
```

---

## Stage 1: Extraction

### Purpose
Extract raw content from source files and assign quality metadata.

### Implementation
**File:** `src/lib/ingestion.ts` → `processFileV2()` → Step 2

**Route by file type:**

```typescript
.pdf   → extractPdf()     → PDF.js native OR Tesseract OCR
.docx  → extractDocx()    → Office Open XML parser
.xlsx  → extractXlsx()    → SheetJS parser
.txt   → extractTxt()     → UTF-8 text reader
.png   → extractImage()   → Tesseract OCR
.jpg   → extractImage()   → Tesseract OCR
.jpeg  → extractImage()   → Tesseract OCR
```

### Extraction Rules

#### Rule 1: PDF Extraction Strategy
- **Try native first** (`PDF.js`)
  - Fast, no external dependencies
  - Preserves layout hints
  - Success rate ~95% on modern PDFs
- **Fall back to OCR** if native extracts <20% of expected content
  - `Tesseract.js` with `eng` language model
  - Slower (1-5 seconds per page)
  - Fallback triggers on:
    - Zero text extracted
    - Scanned/image PDF detected
    - Text confidence <0.5
- **Track method** in `extraction_method` field:
  - `native_pdfjs` → PDF.js used
  - `ocr` → OCR used (primary or fallback)

**Code reference:** `src/lib/extraction/pdf.ts`

#### Rule 2: Metadata Extraction & Quality Scoring
- **Text Quality Score** (0-1 scale)
  - **Native extraction** → Base score 0.9 (high confidence)
  - **OCR** → Calculated from Tesseract confidence
  - **Mixed** → Averaged from extraction method
- **Text Quality Tier** (good/partial/poor)
  - `good` → Score ≥ 0.75 AND native extraction
  - `partial` → Score 0.5-0.75 OR mixed methods
  - `poor` → Score < 0.5 (heavy OCR)
- **Quality Score Source**
  - `native_extraction` → From native method confidence
  - `ocr_output` → From OCR confidence engine
- **Extraction Needs Review Flag**
  - Set if unusual conditions detected:
    - OCR confidence < 0.6
    - Mixed extraction methods on same file
    - Content < 100 words with OCR

**Code reference:** `src/lib/extraction/pdf.ts` → `computeQuality()`

#### Rule 3: Quarantine Detection
- **Quarantine triggers:**
  - Encrypted PDF (password-protected)
  - Corrupted file (unreadable format)
  - Zero text extractable
  - File format mismatch (e.g., `.docx` file with HTML content)
- **Quarantined documents:**
  - All chunks marked `retrieval_excluded = true`
  - Not embedded (no vector search)
  - Flagged in database for review
  - Still searchable via metadata/filename

**Code reference:** `src/lib/ingestion.ts` → `Step 2c`

---

## Stage 2: Normalization

### Purpose
Standardize extracted text and identify structural patterns for intelligent chunking.

### Implementation
**File:** `src/lib/normalise/index.ts`

**Pipeline:**

```
Raw extracted text
  ↓
[Boilerplate Detection] → Fingerprint hash, flag repeated sections
  ↓
[Section Analysis] → Heading detection, content structure
  ↓
[Sanity Checks] → Validate structure, flag anomalies
  ↓
[Normalization Stats] → Track excluded/suspicious content
  ↓
Normalized sections with metadata
```

### Normalization Rules

#### Rule 4: Boilerplate Detection & Fingerprinting
- **Purpose:** Exclude repetitive content (footers, headers, disclaimers)
- **Method:**
  - Compute SHA-256 hash of each paragraph
  - Track across document
  - Paragraphs appearing 5+ times → Flagged as boilerplate
  - Paragraphs appearing in >50% of similar documents → Flagged as corpus boilerplate
- **Action:** Mark as `is_boilerplate = true`, separate from main content
- **Exception:** Tiny documents (<500 words) skip boilerplate flag (often structure stubs)

**Code reference:** `src/lib/normalise/boilerplate.ts` → `computeBoilerplateHash()`

#### Rule 5: Structural Analysis & Heading Detection
- **Heading detection:**
  - Lines matching regex pattern (e.g., `^# `, `^## `, all-caps short lines)
  - Structured formats (DOCX heading styles, markdown)
  - Used to organize chunks hierarchically
- **Content type tagging:**
  - `heading` → Section titles
  - `table` → Formatted tabular data
  - `list` → Bulleted/numbered lists
  - `appendix` → Content after "Appendix", "Attachment" markers
  - `prose` → Regular paragraph text
- **Preservation:**
  - Heading text prepended to following chunks for context
  - Table structure preserved in chunk metadata
  - List items grouped into single chunk when possible

**Code reference:** `src/lib/normalise/structure.ts`

#### Rule 6: Sanity Validation
- **Structural anomalies checked:**
  - Document >10,000 words but <5 headings? → `sanity_warning = true`
  - Tables present but <10% table content? → Flag unusual structure
  - Appendix >50% of document? → Flag for review
  - Zero prose sections? → Flag data-only document
- **Action on warning:**
  - If PDF + sanity warning + not tiny document → Set `needs_review = true`
  - Document still processed but flagged for human inspection
  - Logged: `[needs_review] <filename> — sanity warning from normalisation`

**Code reference:** `src/lib/normalise/index.ts` → `normalisationResult.sanity_warning`

#### Rule 7: Fingerprint Tracking
- **Purpose:** Detect unchanged documents during updates
- **Method:**
  - SHA-256 hash of full normalized output
  - Compare against existing active document
  - If match → Skip Stage 3, update `last_seen_at`, count as skipped
- **Benefit:** Prevents duplicate embedding of identical content

**Code reference:** `src/lib/normalise/boilerplate.ts` → `updateFingerprint()`

---

## Stage 3: Chunking, Embedding & Storage

### Purpose
Convert normalized content into searchable chunks with vector embeddings and relevance metadata.

### Implementation
**File:** `src/lib/ingestion.ts` → `processFileV2()` → Steps 4-7

**Pipeline:**

```
Normalized sections
  ↓
[Type-Aware Chunking] → Prose, spreadsheet, or hybrid chunker
  ↓
[Chunk Metadata] → Page numbers, section titles, content type
  ↓
[Retrieval Exclusion Rules] → Mark ineligible chunks
  ↓
[Eligibility Separation] → Embedded vs excluded vs downranked
  ↓
[Embedding (Eligible Only)] → Vector conversion
  ↓
[Storage] → Database insertion with status tracking
```

### Chunking Rules

#### Rule 8: Type-Aware Chunking Strategy
- **Prose Chunking** (PDFs, DOCX, TXT)
  - Semantic boundary detection
  - Prefer break at paragraph (blank line)
  - Target: 500-1000 words per chunk
  - Min: 100 words, Max: 2000 words
  - Heading preserved as chunk prefix for context
  - **Code:** `src/lib/chunking/prose.ts`
- **Spreadsheet Chunking** (XLSX)
  - Each logical section → Chunk
  - Column headers preserved in every chunk
  - Merged cells handled as single unit
  - Target: 1-2 chunks per sheet
  - **Code:** `src/lib/chunking/spreadsheet.ts`
- **Hybrid Chunking** (Mixed DOCX tables + prose)
  - Detect table boundaries
  - Chunk prose normally
  - Preserve table structure in separate chunks

#### Rule 9: Retrieval Exclusion Rules
- **Chunks marked `retrieval_excluded = true`:**
  - Boilerplate content (footer/header text)
  - Pure metadata (page numbers, document properties)
  - Disclaimer/legal blocks
  - Appendices (configurable, default: lower rank instead)
- **Effect of exclusion:**
  - Not embedded (no vector conversion)
  - Marked `embedding_status = 'skipped_excluded'`
  - Reduces storage/compute cost
  - Still queryable via metadata/exact match
- **Decision logic:** `src/lib/ingestion.ts` → `Step 4a`

#### Rule 10: Downranking Rules
- **Chunks marked `retrieval_downranked = true`:**
  - Appendix content (rank boost disabled)
  - Low-content-density sections
  - Highly boilerplate-adjacent paragraphs
- **Effect of downranking:**
  - Embedded normally (searchable)
  - Scoring penalty applied at retrieval time
  - Penalty multiplier: `DOWNRANK_PENALTY` (default: 0.5)
  - Applied in retrieval scoring: `final_score *= penalty`
- **Decision logic:** `src/lib/chunking/prose.ts` → `computeDownrankStatus()`

#### Rule 11: Quarantine Chunk Handling
- **If document quarantined:**
  - ALL chunks marked `retrieval_excluded = true`
  - ALL chunks marked `embedding_status = 'skipped_excluded'`
  - Zero embeddings generated
  - Document inaccessible to semantic search
  - Metadata-only queries work

**Code reference:** `src/lib/ingestion.ts` → `Step 4a`

### Embedding Rules

#### Rule 12: Batch Embedding
- **Batch size:** `EMBED_BATCH_SIZE` (default: 50)
- **Only eligible chunks embedded:**
  - `retrieval_excluded = false`
  - Document not quarantined
  - Content exists
- **Embedding model:** Stored in database (`embedding_model` field)
  - Track for migration purposes
  - Currently: `text-embedding-3-small` (Anthropic)
- **Failure handling:**
  - Individual chunk failure → Mark `embedding_status = 'failed'`, log error, continue
  - Batch timeout → Retry with smaller batch
  - Max retries: 3 per chunk
- **Tracking:**
  - `embedded_chunk_count` → Successfully embedded
  - `skipped_embedding_count` → Skipped (excluded/quarantined)

**Code reference:** `src/lib/embeddings.ts` → `embedBatch()`

### PDF Completeness Trust Audit

#### Rule 13: PDF Extraction Trust Scoring
- **Triggered:** After all chunks stored for PDF documents
- **Metrics calculated:**
  - Heading chunks present? → Structure confidence
  - Appendix detected? → Document structure variance
  - Table chunks present? → Formatted data captured
  - OCR used? → Reduce confidence
  - Text quality score? → Direct confidence input
- **Risk assessment:**
  - `high` → Use OCR fallback, low text quality score, suspicious structure
  - `medium` → Mixed extraction or some structural anomalies
  - `low` → Native extraction, good quality score, clear structure
- **Completeness status:**
  - `complete` → Risk low, document trust high
  - `partial` → Risk medium, document trust moderate
  - `suspect` → Risk high, document trust low
- **Storage:** `pdf_completeness_trust` table, linked to document

**Code reference:** `src/lib/pdfCompleteness.ts` → `auditPdfCompleteness()`

### Storage & Indexing

#### Rule 14: Document & Chunk Storage
- **Document record:**
  - `id` (UUID)
  - `title`, `filename`, `source_path` (tracking)
  - `version_hash` (content fingerprint)
  - `is_active` (current/superseded)
  - `extraction_status` (extracting/chunking/embedding/completed/failed)
  - `extraction_error` (null if success, error message if failed)
  - `text_quality_score`, `text_quality_tier`, `quality_score_source`
  - `extraction_method` (native vs ocr)
  - `ocr_used`, `ocr_confidence` (tracking)
  - `needs_review` (flag for manual inspection)
  - `quarantined` (encrypted/corrupted)
  - `pipeline_version` (v2)
  - `chunk_count`, `excluded_chunk_count`, `boilerplate_chunk_count`, `downranked_chunk_count`
  - `pdf_completeness_trust_status` (complete/partial/suspect)
  - Timestamps: `created_at`, `updated_at`, `processed_at`
- **Chunk record:**
  - `id` (UUID)
  - `document_id` (parent document)
  - `chunk_index` (position in document)
  - `content` (text)
  - `embedding` (vector, 1536 dimensions)
  - `page_number` (PDF-specific)
  - `section_title` (heading context)
  - `content_type` (heading/table/list/prose)
  - `is_boilerplate` (repetitive content)
  - `retrieval_excluded` (should not be searched)
  - `retrieval_downranked` (lower ranking)
  - `embedding_status` (embedded/skipped_excluded/failed)
- **Indexing:**
  - `embedding` → Vector search via pgvector
  - `document_id` → Retrieval filtering
  - `retrieval_excluded` → Exclusion filtering
  - `is_active` (via documents.is_active) → Active/inactive scoping

**Code reference:** `src/lib/repositories/documents.ts`, `src/lib/repositories/chunks.ts`

---

## Integration Points

### Ingestion Pipeline Entry Points

#### CLI Trigger
```bash
npx tsx scripts/ingest.ts [--force] [--rebuild] [--file <path>]
```
- `--force` → Force reprocess all files (ignore fingerprint)
- `--rebuild` → Two-pass mode (extract all, then process all)
- `--file <path>` → Single file only

**File:** `scripts/ingest.ts`

#### API Trigger
```http
POST /api/ingest
Content-Type: application/json
{
  "sourcePath": "/path/to/docs",
  "forceReprocess": false,
  "rebuild": false
}
```
- Returns SSE stream with progress events
- Real-time status updates

**File:** `src/app/api/ingest/route.ts`

#### Frontend UI Trigger (Future)
- File upload picker
- Triggers API endpoint above
- Shows progress via SSE

**File:** `src/app/ingest/page.tsx` (enhanced)

### Retrieval Integration

#### During Chat
- Query routed to `src/lib/retrieval.ts`
- Filters applied:
  - `document.is_active = true` (skip superseded versions)
  - `chunk.retrieval_excluded = false` (skip excluded chunks)
  - `document.quarantined = false` (skip quarantined)
- Scoring applied:
  - Base: Vector similarity score
  - Downrank penalty: `score *= DOWNRANK_PENALTY` if `retrieval_downranked = true`
- Top-K chunks returned for answer synthesis

**File:** `src/lib/retrieval.ts`

---

## Configuration & Environment

### Key Environment Variables

```bash
# Ingestion behavior
INGEST_FILE_CONCURRENCY=5        # Parallel files processed
EMBED_BATCH_SIZE=50              # Vectors computed per batch
DOWNRANK_PENALTY=0.5             # Downrank score multiplier

# Quality thresholds
QUALITY_SCORE_THRESHOLD_PDF=0.5  # Min score for "good" tier
OCR_CONFIDENCE_MIN=0.6           # Min OCR confidence before flag
TEXT_MIN_WORDS_NATIVE=100        # Min native extraction words

# Feature flags
ENABLE_BOILERPLATE_DETECTION=true
ENABLE_SANITY_WARNINGS=true
ENABLE_PDF_AUDIT=true
```

### Database Schema
- `documents` table → Tracks all document versions and metadata
- `chunks` table → Individual chunks with embeddings
- `ingest_runs` table → Audit trail of ingestion jobs
- `pdf_completeness_trust` table → Trust scores for PDFs

---

## Troubleshooting & Extension

### Adding a New Extraction Method
1. Create new extractor in `src/lib/extraction/<type>.ts`
2. Implement `ExtractedContent` interface
3. Add routing in `extractFile()` function
4. Add MIME type to `SUPPORTED_EXTENSIONS`
5. Update extraction methods tracking

### Modifying Chunk Size
- Edit `TARGET_CHUNK_SIZE`, `MIN_CHUNK_SIZE`, `MAX_CHUNK_SIZE` in `src/lib/chunking/prose.ts`
- Smaller chunks → More granular retrieval, higher storage
- Larger chunks → Broader context, fewer storage/embed calls

### Adjusting Quality Thresholds
- Edit tier classification in `src/lib/extraction/pdf.ts`
- Adjust penalty multiplier in `src/lib/retrieval.ts`
- Modify sanity check conditions in `src/lib/normalise/index.ts`

### Monitoring Ingestion Health
- Check `ingest_runs` table for run statistics
- Monitor `extraction_status` distribution
- Track `text_quality_tier` distribution over time
- Alert on high `needs_review` rate

---

## Performance Characteristics

### Typical Processing Times
- **Small PDF (5 pages, <1MB):** 10-15 seconds (native extraction)
- **Large PDF (100+ pages, 10MB+):** 2-3 minutes (native or OCR)
- **Scanned PDF (1-5 pages, heavy OCR):** 30-60 seconds per page
- **DOCX (5 pages):** 5-10 seconds
- **XLSX (1 sheet, <1000 cells):** 5-10 seconds
- **Image (single, 2000x2000 pixels):** 20-45 seconds (OCR)

### Storage Impact
- **Small document (10 chunks):** ~100KB (content + metadata)
- **Typical document (100 chunks):** ~1MB (vectors = 600KB)
- **Large document (500 chunks):** ~5MB (vectors = 3MB)

### API Resource Usage
- Extraction → CPU-bound
- Embedding → CPU-bound + network (to embedding service)
- Storage → I/O-bound
- Concurrent files limited by `INGEST_FILE_CONCURRENCY`

---

## Testing & Validation

### Unit Tests
- `src/lib/extraction/*.test.ts` → Extraction logic
- `src/lib/chunking/*.test.ts` → Chunking rules
- `src/lib/normalise/*.test.ts` → Normalization & boilerplate
- `src/lib/embeddings.test.ts` → Embedding integration

### Integration Tests
- `scripts/test-generation.ts` → End-to-end ingestion
- `scripts/validate-ingest-reporting.ts` → Metrics validation

### Manual Testing Checklist
- [ ] Upload PDF with native extraction → Verify quality tier "good"
- [ ] Upload scanned PDF → Verify OCR fallback, quality tier "partial"
- [ ] Upload DOCX with tables → Verify table preservation
- [ ] Upload duplicate → Verify fingerprint match, skip
- [ ] Upload modified version → Verify deactivate old, new version active
- [ ] Check chunk counts → Verify exclusions/downranks correct
- [ ] Query extracted document → Verify chunks appear in retrieval

---

## References

- **V2 Data Quality Rebuild Spec:** `docs/specs/2026-04-17-v2-data-quality-rebuild.md`
- **Ingestion Implementation Plan:** `docs/plans/2026-04-17-v2-data-quality-rebuild-plan.md`
- **Source Code:** `src/lib/ingestion.ts`, `src/lib/extraction/`, `src/lib/normalise/`, `src/lib/chunking/`
