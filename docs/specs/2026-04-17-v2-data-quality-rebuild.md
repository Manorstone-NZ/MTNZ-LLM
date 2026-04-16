# V2 Data Quality Rebuild — Technical Specification

**Date:** 2026-04-17
**Status:** DRAFT
**Author:** Damian + Claude (AI specification partner)
**Predecessor:** `2026-04-16-idd-knowledge-chat-design.md` (v1 system spec)

---

## 1. Purpose

Rebuild the ingestion pipeline to produce a significantly higher-quality chunk store. The v1 corpus has 13,005 chunks of which 72% are under 50 tokens (fragments, boilerplate, noise). This rebuild introduces a three-stage pipeline — Extract → Normalise → Compose — that classifies sections, suppresses junk, preserves meaningful structure, and only then composes retrieval chunks.

## 2. Problem Statement

V1 data shape (measured):

| Metric | Value | Problem |
|--------|-------|---------|
| Chunks under 20 tokens | 4,311 (33%) | Single-word fragments, noise |
| Chunks under 50 tokens | 9,442 (72%) | Too short for meaningful retrieval |
| Average chunk tokens | ~50 | Should be 150-300 |
| Duplicate boilerplate blocks | 82x (TITAN header), 29x (PPE text) | Pollutes retrieval |
| "CONTROLLED COPY" heading chunks | 4,559 | Watermark treated as structure |
| Scanned PDFs treated as success | 2 | Bad extraction not caught |

## 3. Pipeline Architecture

```
Stage 1: EXTRACT
  PDF (with quality gate + OCR fallback)
  DOCX (mammoth — existing)
  XLSX (SheetJS — existing)
  TXT (existing)
      ↓
  ExtractedSection[] per document
      ↓
Stage 2: NORMALISE
  2a. Classify section types
  2b. Suppress boilerplate (rule-based + corpus fingerprint)
  2c. Structural cleanup (merge, dedup, drop empty headings)
      ↓
  NormalisedSection[] per document
      ↓
Stage 3: COMPOSE
  Prose chunker (existing, updated for type-awareness)
  Spreadsheet chunker (existing, updated for type-awareness)
      ↓
  PreparedChunk[] with section_type, exclusion flags
      ↓
  Embed only retrieval-eligible chunks
      ↓
  Store all chunks; only embedded chunks searchable
```

## 4. Stage 1: Extract

### 4.1 PDF quality gate (new)

After text extraction, before any downstream processing, assess text quality.

**Quality scoring model:**

| Signal | Weight | What it detects |
|--------|--------|-----------------|
| Printable/alphanumeric ratio | 0.25 | Garbled binary extraction |
| Average token length sanity (real English: 4-6 chars) | 0.20 | Broken ligatures, gibberish |
| Dictionary/domain-term hit rate | 0.25 | Meaningful vs random text |
| Proportion of pages with usable text | 0.15 | Mixed-mode documents |
| Suspicious character/token pattern rate | 0.15 | Excessive punctuation, repeated single chars, mixed alpha-numeric gibberish |

**Quality tiers:**
- **Good** (score > 0.8) → proceed to normalise
- **Partial** (0.4–0.8) → proceed but set `needs_review: true`
- **Poor** (< 0.4) → route to OCR

**Stored per document:**
- `extraction_method`: `native_pdf` | `ocr` | `native_docx` | `native_xlsx` | `native_txt`
- `text_quality_score`: 0.0–1.0
- `text_quality_tier`: `good` | `partial` | `poor`
- `quality_score_source`: `native_extraction` | `ocr_output`
- `needs_review`: boolean

### 4.2 OCR pipeline (new)

For documents with Poor quality extraction.

**Approach:**
- Use native system Tesseract binary if available (faster, more stable for batch)
- Fall back to tesseract.js if no native binary (fully self-contained in Node)
- Convert PDF pages to images using pdf-to-img or pdfjs-dist canvas rendering
- OCR each page individually
- Stitch results with page numbers preserved
- Run quality scoring on OCR output
- If OCR output also poor:
  - Store the OCR output anyway (do not discard)
  - Set `text_quality_tier: 'poor'`, `needs_review: true`
  - Mark all chunks from this document as `retrieval_excluded: true`
  - Set `extraction_status: 'completed'` (not 'failed' — the document is visible but quarantined)
  - This ensures: document is visible in dashboard, not polluting retrieval, can be reprocessed later

**V2 scope:** Whole-document OCR (all pages). Page-level mixed mode (native text for good pages, OCR for bad pages) is deferred to v3.

### 4.3 Existing extractors

DOCX, XLSX, TXT extractors remain as-is. They gain:
- `extraction_method` set to `native_docx` | `native_xlsx` | `native_txt`
- `text_quality_tier` set to `good` (these formats extract reliably)

## 5. Stage 2: Normalise (new)

### 5.1 Section classification

Classify every `ExtractedSection` into a canonical type:

| Type | Description | Retrieval treatment |
|------|-------------|---------------------|
| `heading` | Section headers | Include |
| `paragraph` | Body text | Include |
| `procedure_step` | Numbered/lettered steps in a procedure | Include (preserve intact) |
| `instruction_block` | Imperative instructions not strictly step-numbered ("Ensure the sample is mixed", "Record results in LIMS") | Include (preserve intact) |
| `table` | Tabular data | Include (preserve intact) |
| `warning` | WARNING, CAUTION, NOTE, IMPORTANT blocks | Include (preserve intact) |
| `note` | Informational notes | Include |
| `revision_history` | Amendment/version history tables | **Down-rank** |
| `appendix` | Appendix content | **Down-rank** |
| `metadata_only` | Document control blocks | **Down-rank** |
| `footer_header` | Repeated per-page headers/footers | **Exclude** |
| `form_stub` | Empty form sections ("12.2 FORMS", "N/A") | **Exclude** |
| `boilerplate` | Generic repeated text (PPE, controlled copy) | **Exclude** |

**Classification uses:**
- Heading text patterns ("REVISION HISTORY", "APPENDIX", "FORMS")
- Content patterns (WARNING/CAUTION/NOTE prefix, numbered step sequences)
- Position within document (first/last sections more likely metadata)
- Parent heading context

**Confidence:** The classifier returns a `section_type_confidence` (0.0–1.0) per section. The code is structured so confidence can be exposed later; for v2, confidence is stored but not used in filtering decisions.

### 5.2 Boilerplate suppression

Two mechanisms, used together:

**Rule-based patterns:**
- "CONTROLLED COPY IF THIS LINE IS GREEN"
- "THIS DOCUMENT IS UNCONTROLLED"
- Page number lines (bare numbers, "Page X of Y")
- Standard PPE safety blocks (match by known phrase fingerprints)
- Recurring export headers (TITAN client export header row)
- Generic revision history blocks

**Corpus-level content fingerprinting:**

A block is marked boilerplate ONLY if BOTH conditions are met:
1. It appears in N+ documents (threshold: 20)
2. AND it matches at least one of:
   - A known boilerplate pattern from the rule list, OR
   - A low-information heuristic:
     - Very low unique-term count
     - Mostly generic operational language
     - No domain-specific identifiers (equipment names, test types, chemical names)
     - No procedural verbs with measurable conditions (e.g., "incubate at 37°C for 24h")
     - No equipment references

This two-part test prevents legitimate controls that appear across many documents from being falsely suppressed.

**Protected content override (hard rule):**

A block must NEVER be marked boilerplate — regardless of frequency or pattern match — if it contains ANY of:
- Numeric constraints (temperatures, times, thresholds, concentrations)
- Equipment identifiers (instrument names, model numbers)
- Test codes or method IDs
- Chemical or biological terms
- Measurable conditions ("incubate at 37°C for 24h", "centrifuge at 3000 rpm", "hold at 4°C")

This override takes precedence over both rule-based and fingerprint-based suppression. It ensures that repeated compliance-critical instructions with specific technical content are never suppressed.

**Fingerprinting method:**
1. Normalise: lowercase, collapse whitespace, strip dates/page numbers/version stamps
2. SHA-256 the normalised text
3. Count corpus-wide occurrences (stored in a `boilerplate_fingerprints` lookup table or computed during ingest)

### 5.3 Structural cleanup

**Merge adjacent tiny sections:**
- Adjacent sections under 50 tokens each that share a parent heading → merge into one section
- Exception: do not merge across different section types (don't merge a paragraph into a table)

**Drop empty headings:**
- Headings with no usable child content after suppression → remove

**Deduplicate within a document:**
- Only deduplicate when ALL of:
  - Exact normalised text match
  - Same section type
  - Same parent heading or equivalent structural context
  - NOT a `procedure_step` or `warning` (these may legitimately repeat in different contexts)
- Keep the first occurrence with its page context

**Very short content policy:**
- Drop under 20 tokens ONLY IF:
  - Isolated (not adjacent to a meaningful parent)
  - AND untyped (not `table`, `procedure_step`, `warning`, `note`, or title with attached content)
- Keep under 20 tokens if tagged as any meaningful type

## 6. Stage 3: Compose

### 6.1 Chunker updates

Existing prose and spreadsheet chunkers remain the base implementation. They are updated to be **type-aware**:

- `procedure_step` sections: never merge into an unrelated paragraph, even if token limits allow it
- `warning` and `note` sections: keep as distinct chunks, do not absorb into surrounding text
- `table` sections: remain atomic (existing behaviour, preserved)
- `revision_history`, `appendix`, `metadata_only`: chunk normally but mark chunks with `retrieval_downranked: true`
- `footer_header`, `form_stub`, `boilerplate`: chunk and store but mark `retrieval_excluded: true`
- `instruction_block`: treat like `procedure_step` — never merge into unrelated text

### 6.2 Post-compose guardrail

After compose, apply a final minimum chunk size check:
- Drop chunks under 30 tokens UNLESS `section_type` is one of: `table`, `procedure_step`, `instruction_block`, `warning`, `note`
- This catches edge cases where compose still produces tiny fragments

### 6.3 Post-normalisation sanity check

Before compose, run a document-level sanity check:
- If >80% of sections are excluded → flag document `needs_review: true`
- If total remaining sections < 3 → flag document `needs_review: true`
- If average section token count < 15 → flag document `needs_review: true`

This catches bad extraction or misclassification early.

### 6.4 Hard cap on chunk size

- Hard maximum: 1,000 tokens — chunks exceeding this must be split regardless of structure
- Soft target: 150–300 tokens for typical prose chunks

### 6.5 Embedding policy

**Only embed chunks where `retrieval_excluded = false`.**

Excluded/archive material is stored without embeddings. This gives:
- Lower embedding cost
- Less vector noise
- Smaller index
- Simpler retrieval filtering

If excluded content needs to be searchable later, it can be selectively embedded or queried via FTS/trigram only.

**Embedding status tracked per chunk:**
- `pending` — not yet processed (default for new rows)
- `embedded` — has a valid embedding vector
- `skipped_excluded` — stored but not embedded (excluded or boilerplate)
- `failed` — embedding attempted but failed

## 7. Schema Changes

### 7.1 Migration: `002_v2_data_quality.sql`

**documents — add columns:**

```sql
ALTER TABLE documents ADD COLUMN pipeline_version TEXT NOT NULL DEFAULT 'v2';
ALTER TABLE documents ADD COLUMN extraction_method TEXT;
ALTER TABLE documents ADD COLUMN text_quality_score NUMERIC;
ALTER TABLE documents ADD COLUMN text_quality_tier TEXT;
ALTER TABLE documents ADD COLUMN quality_score_source TEXT;
ALTER TABLE documents ADD COLUMN needs_review BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE documents ADD COLUMN excluded_chunk_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE documents ADD COLUMN boilerplate_chunk_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE documents ADD COLUMN downranked_chunk_count INTEGER NOT NULL DEFAULT 0;
```

**chunks — add columns:**

```sql
ALTER TABLE chunks ADD COLUMN section_type TEXT;
ALTER TABLE chunks ADD COLUMN section_type_confidence NUMERIC;
ALTER TABLE chunks ADD COLUMN is_boilerplate BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE chunks ADD COLUMN retrieval_excluded BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE chunks ADD COLUMN retrieval_downranked BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE chunks ADD COLUMN boilerplate_hash TEXT;
ALTER TABLE chunks ADD COLUMN embedding_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE chunks ADD COLUMN normalisation_reason JSONB;

-- Make embedding nullable for excluded chunks that aren't embedded
ALTER TABLE chunks ALTER COLUMN embedding DROP NOT NULL;
```

**boilerplate_fingerprints table (new):**

```sql
CREATE TABLE boilerplate_fingerprints (
  hash TEXT PRIMARY KEY,
  sample_text TEXT,              -- first 200 chars of the normalised block
  occurrence_count INTEGER NOT NULL DEFAULT 0,
  is_confirmed_boilerplate BOOLEAN NOT NULL DEFAULT false,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**normalisation_reason column:**

The `chunks.normalisation_reason` JSONB column stores traceability for normalisation decisions. Examples:

```json
{"classification": "footer_header", "excluded": true, "reason": "matched_pattern: CONTROLLED_COPY"}
{"classification": "paragraph", "merged_with": [3, 4], "reason": "adjacent_small_sections"}
{"classification": "boilerplate", "excluded": true, "reason": "corpus_fingerprint: hash=abc123, count=45"}
{"classification": "procedure_step", "protected": true, "reason": "contains_measurable_condition"}
```

Not required on every row — populated when a non-trivial normalisation decision is made (exclusion, merge, dedup, protection override).

**Update retrieval indexes:**

```sql
-- Partial index for retrieval: only searchable chunks
CREATE INDEX idx_chunks_retrieval_embedding ON chunks
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)
  WHERE retrieval_excluded = false AND embedding_status = 'embedded';

-- Drop old full embedding index if it exists
DROP INDEX IF EXISTS idx_chunks_embedding;
```

### 7.2 Retrieval query updates

**Vector search:**
```sql
WHERE d.is_active = true
  AND c.retrieval_excluded = false
  AND c.embedding_status = 'embedded'
```

**FTS / trigram search:**
```sql
WHERE d.is_active = true
  AND c.retrieval_excluded = false
```

**Down-ranked content handling:**
If `retrieval_downranked = true`, apply a configurable score penalty (multiply score by `DOWNRANK_PENALTY`, default 0.5) rather than excluding. This means revision history and appendices can appear in results but only when other evidence is sparse or the query directly targets them.

Add to `.env.local`:
```
DOWNRANK_PENALTY=0.5
```

## 8. Type Definitions

**NormalisedSection** (new type, extends ExtractedSection):

```typescript
interface NormalisedSection extends ExtractedSection {
  section_type: SectionType;
  section_type_confidence: number;
  retrieval_excluded: boolean;
  retrieval_downranked: boolean;
  is_boilerplate: boolean;
  boilerplate_hash: string | null;
  normalisation_reason: Record<string, unknown> | null;
}

type SectionType =
  | 'heading' | 'paragraph' | 'procedure_step' | 'instruction_block'
  | 'table' | 'warning' | 'note'
  | 'revision_history' | 'appendix' | 'metadata_only'
  | 'footer_header' | 'form_stub' | 'boilerplate';
```

This type is explicitly defined in `src/lib/types.ts` and is the interface between Stage 2 (normalise) and Stage 3 (compose).

## 9. New File Structure

```
src/lib/
├── normalise/
│   ├── classify.ts         — section type classification with confidence
│   ├── boilerplate.ts      — rule-based patterns + corpus fingerprinting
│   ├── cleanup.ts          — merge, dedup, drop empty headings, short content policy
│   └── index.ts            — orchestrates classify → suppress → cleanup
├── extraction/
│   ├── pdf.ts              — gains quality gate call
│   ├── pdf-quality.ts      — quality scoring model (new)
│   ├── ocr.ts              — OCR pipeline with Tesseract (new)
│   ├── docx.ts             — existing
│   ├── xlsx.ts             — existing
│   └── txt.ts              — existing
├── chunking/
│   ├── prose.ts            — updated for section-type awareness
│   └── spreadsheet.ts      — updated for section-type awareness
├── ingestion.ts            — updated for three-stage pipeline
└── ...existing files...
```

## 10. Migration Approach (Controlled)

This is a clean-slate rebuild executed as a controlled operational sequence:

1. **Add schema changes** — run `002_v2_data_quality.sql` (additive, non-breaking)
2. **Snapshot current metrics** — record: total docs, total chunks, chunk size distribution, status breakdown
3. **Disable normal ingest** — prevent accidental ingestion during rebuild
4. **Mark all current documents** as `pipeline_version = 'v1'`, `is_active = false`
5. **Re-ingest with v2 pipeline** — full corpus, all documents ingested as `pipeline_version = 'v2'`
6. **Compare metrics** — v2 corpus against v1 snapshot, verify acceptance criteria
7. **If satisfied** — purge v1 documents and their chunks (`DELETE WHERE pipeline_version = 'v1'`)
8. **Resume normal use** — re-enable ingest controls

This approach gives a rollback path: if v2 is worse, reactivate v1 documents and delete v2.

## 11. Acceptance Criteria

### Data shape
- Less than 15% of retrieval-eligible chunks under 50 tokens
- Less than 2% under 20 tokens (excluding preserved tables/steps/warnings)
- Average chunk token count above 150 for retrieval-eligible chunks
- Duplicate boilerplate blocks reduced by at least 80% in retrieval corpus

### PDF quality
- Poor-quality native PDF extraction routes to OCR
- Partial-quality documents surfaced in dashboard with `needs_review = true`
- OCR documents visibly marked with `extraction_method` and `ocr_used`

### Normalisation
- Footer/header blocks excluded from retrieval
- Revision history and appendix blocks preserved but down-ranked (not dominant in search)
- Procedure steps and warnings preserved intact
- No false-positive boilerplate suppression of legitimate domain controls

### Retrieval
- Top results for known procedural questions contain substantive chunks, not fragments
- Excluded chunks never appear in normal retrieval results
- Down-ranked chunks appear only when evidence is otherwise sparse or directly relevant
- Vector search only queries embedded chunks
- **Retrieval density:** at least 80% of top-10 retrieved chunks have `token_count > 100` for typical procedural queries

### Observability
- Per-document quality metrics visible in dashboard (tier, score, needs_review)
- Per-document chunk counts: total, excluded, boilerplate, downranked
- Pipeline version tracked on all documents

## 12. Out of Scope for V2

- Page-level mixed-mode OCR (native + OCR per page)
- Glossary-based query expansion (next improvement after rebuild)
- Conversation-aware retrieval (query condensation)
- Explicit admin "search excluded content" mode
- Feedback loop / thumbs up/down
- Splitting into separate retrieval and archive tables
