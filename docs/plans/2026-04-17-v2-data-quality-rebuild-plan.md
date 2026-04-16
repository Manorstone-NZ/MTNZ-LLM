# V2 Data Quality Rebuild — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the ingestion pipeline with a three-stage Extract → Normalise → Compose architecture that produces 3,000–5,000 high-quality chunks from the same 137 source documents (down from 13,005 noisy fragments).

**Architecture:** Add a normalisation stage between extraction and chunking that classifies sections, suppresses boilerplate, and applies structural cleanup. Update extractors with PDF quality gating and OCR fallback. Update chunkers to be section-type-aware. Only embed retrieval-eligible chunks.

**Tech Stack:** Existing stack (Next.js, PostgreSQL/Docker, LM Studio, tiktoken) plus tesseract.js for OCR fallback.

**Spec:** `docs/specs/2026-04-17-v2-data-quality-rebuild.md`

---

## File Map

### New files
| File | Responsibility |
|------|---------------|
| `db/migrations/002_v2_data_quality.sql` | Schema additions: new columns, constraints, indexes |
| `src/lib/extraction/pdf-quality.ts` | PDF text quality scoring model |
| `src/lib/extraction/ocr.ts` | Tesseract OCR pipeline |
| `src/lib/normalise/classify.ts` | Section type classification with confidence |
| `src/lib/normalise/boilerplate.ts` | Rule-based + corpus fingerprint suppression |
| `src/lib/normalise/cleanup.ts` | Merge, dedup, drop empty headings, short content policy |
| `src/lib/normalise/index.ts` | Orchestrates classify → suppress → cleanup |
| `scripts/snapshot-v1.ts` | Captures v1 metrics before rebuild |
| `scripts/compare-metrics.ts` | Compares v2 metrics against v1 snapshot |

### Modified files
| File | Changes |
|------|---------|
| `src/lib/types.ts` | Add NormalisedSection, SectionType, update PreparedChunk, DocumentRow, HealthMetrics, IngestRunResult |
| `src/lib/extraction/pdf.ts` | Add quality gate call, route to OCR on poor quality |
| `src/lib/chunking/prose.ts` | Section-type awareness: respect procedure_step, warning, instruction_block boundaries |
| `src/lib/chunking/spreadsheet.ts` | Section-type awareness: mark excluded/downranked |
| `src/lib/ingestion.ts` | Three-stage pipeline, normalise between extract and compose, embedding policy, v2 metrics |
| `src/lib/repositories/documents.ts` | New v2 columns in CRUD, health metrics for quarantined/v2 counts |
| `src/lib/repositories/chunks.ts` | Retrieval queries add exclusion filters, downrank penalty |
| `src/lib/retrieval.ts` | Apply DOWNRANK_PENALTY to downranked chunks |
| `src/app/api/docs/route.ts` | Expose v2 health metrics |
| `src/components/ingest/HealthDashboard.tsx` | Show quarantined count, quality tiers |

---

## Phase 1: Foundation (sequential)

### Task 1: Schema migration + type updates

**Files:**
- Create: `db/migrations/002_v2_data_quality.sql`
- Modify: `src/lib/types.ts`

- [ ] **Step 1: Create migration file**

Full SQL from spec section 7.1. Includes:
- documents: pipeline_version, extraction_method, text_quality_score, text_quality_tier, quality_score_source, needs_review, excluded_chunk_count, boilerplate_chunk_count, downranked_chunk_count, quarantined
- chunks: section_type, section_type_confidence, is_boilerplate, retrieval_excluded, retrieval_downranked, boilerplate_hash, embedding_status (default 'pending'), normalisation_reason JSONB
- chunks.embedding DROP NOT NULL
- boilerplate_fingerprints table
- ingest_runs: v2-specific count columns
- All CHECK constraints (text_quality_tier, extraction_method, quality_score_source, embedding_status, section_type)
- Partial vector index replacing old full index

- [ ] **Step 2: Run migration**

```bash
docker exec -i idd-knowledge-db psql -U damian -d idd_knowledge < db/migrations/002_v2_data_quality.sql
```

Verify: `\d documents` and `\d chunks` show new columns.

- [ ] **Step 3: Update src/lib/types.ts**

Add:
```typescript
export type SectionType =
  | 'heading' | 'paragraph' | 'procedure_step' | 'instruction_block'
  | 'table' | 'warning' | 'note'
  | 'revision_history' | 'appendix' | 'metadata_only'
  | 'footer_header' | 'form_stub' | 'boilerplate';

export interface NormalisedSection extends ExtractedSection {
  section_type: SectionType;
  section_type_confidence: number;
  retrieval_excluded: boolean;
  retrieval_downranked: boolean;
  is_boilerplate: boolean;
  boilerplate_hash: string | null;
  normalisation_reason: Record<string, unknown> | null;
}
```

Update `ExtractedSection.type` to include `'instruction_block'`.

Update `PreparedChunk` to add:
```typescript
  section_type: SectionType | null;
  is_boilerplate: boolean;
  retrieval_excluded: boolean;
  retrieval_downranked: boolean;
  boilerplate_hash: string | null;
  normalisation_reason: Record<string, unknown> | null;
  embedding_status: 'pending' | 'embedded' | 'skipped_excluded' | 'failed';
```

Update `DocumentRow` to add all new document columns.

Update `HealthMetrics` to add: `quarantined_count`, `needs_review_count`.

Update `IngestRunResult` to add: `ocr_routed`, `quarantined`, `excluded_chunks`, `downranked_chunks`, `embedded_chunks`, `skipped_embeddings`.

- [ ] **Step 4: Commit**

```bash
git add db/migrations/002_v2_data_quality.sql src/lib/types.ts
git commit -m "feat: v2 schema migration and type definitions"
```

**Acceptance criteria:**
- Migration runs without errors
- All CHECK constraints active
- New columns have correct defaults
- boilerplate_fingerprints table exists
- NormalisedSection type compiles

---

### Task 2: PDF quality scoring

**Files:**
- Create: `src/lib/extraction/pdf-quality.ts`

- [ ] **Step 1: Implement quality scoring model**

```typescript
export interface QualityAssessment {
  score: number;           // 0.0–1.0
  tier: 'good' | 'partial' | 'poor';
  source: 'native_extraction' | 'ocr_output';
  signals: {
    printable_ratio: number;
    avg_token_length: number;
    dictionary_hit_rate: number;
    pages_with_text_ratio: number;
    suspicious_pattern_rate: number;
  };
}

export function assessTextQuality(
  text: string,
  pageTexts: string[],
  source: 'native_extraction' | 'ocr_output'
): QualityAssessment
```

Scoring signals (from spec 4.1):
- **Printable/alphanumeric ratio** (weight 0.25): count printable chars / total chars
- **Average token length sanity** (weight 0.20): split on whitespace, compute mean length. Real English: 4–6 chars. Penalise <2 or >12.
- **Dictionary/domain-term hit rate** (weight 0.25): check words against a small built-in dictionary (~1000 common English words) plus MTNZ domain terms (MADCAP, TITAN, LIMS, MPI, IANZ, MilkoScan, BactoScan, CombiFoss, etc.). Hit rate = matched / total unique words.
- **Proportion of pages with usable text** (weight 0.15): pages where extracted text > 50 chars.
- **Suspicious character/token pattern rate** (weight 0.15): detect excessive punctuation sequences, repeated single-character tokens, mixed alpha-numeric gibberish patterns.

Tiers: good (>0.8), partial (0.4–0.8), poor (<0.4).

- [ ] **Step 2: Build domain terms list**

A small inline constant of ~100 MTNZ-specific terms for the dictionary check: equipment names, test types, organisational terms, chemical/biological terms. Sourced from DOM-GLOSS.

- [ ] **Step 3: Test with known good and bad PDFs**

Test against a text-rich LOP PDF (expect: good) and verify that random binary data or very short text scores as poor.

- [ ] **Step 4: Commit**

```bash
git add src/lib/extraction/pdf-quality.ts
git commit -m "feat: PDF text quality scoring model"
```

**Acceptance criteria:**
- Text-rich LOPs score > 0.8 (good tier)
- Random/garbage text scores < 0.4 (poor tier)
- All 5 signals computed and returned
- Domain terms boost hit rate for lab vocabulary

---

### Task 3: OCR pipeline

**Files:**
- Create: `src/lib/extraction/ocr.ts`
- Modify: `package.json` (add tesseract.js if not present)

- [ ] **Step 1: Install tesseract.js**

```bash
npm install tesseract.js
```

- [ ] **Step 2: Implement OCR extraction**

```typescript
export async function ocrPdf(
  buffer: Buffer,
  filename: string,
  onPageProgress?: (page: number, total: number) => void
): Promise<ExtractedContent>
```

Pipeline:
1. Convert PDF pages to images (use pdfjs-dist or pdf-to-img — check which is available/installable)
2. For each page image, run Tesseract.js OCR
3. Collect per-page text
4. Run section detection on OCR text (reuse existing detectSections from pdf.ts or a shared function)
5. Return ExtractedContent with `ocr_used: true`

If native Tesseract binary is available at `/usr/local/bin/tesseract` or `/opt/homebrew/bin/tesseract`, prefer it. Otherwise use tesseract.js.

Handle failure gracefully: if OCR produces nothing usable, return ExtractedContent with empty sections and metadata indicating failure.

- [ ] **Step 3: Integrate into PDF extractor**

Modify `src/lib/extraction/pdf.ts`:
- After native text extraction, call `assessTextQuality()`
- If tier is 'poor' → call `ocrPdf()` instead
- If tier is 'partial' → proceed with native text but set `needs_review: true`
- Store quality assessment results in metadata

- [ ] **Step 4: Test with a scanned PDF**

If available, test with one of the 2 previously failed PDFs from v1. Otherwise test with a synthetically degraded PDF.

- [ ] **Step 5: Commit**

```bash
git add src/lib/extraction/ocr.ts src/lib/extraction/pdf.ts package.json package-lock.json
git commit -m "feat: OCR pipeline with quality-gated PDF extraction"
```

**Acceptance criteria:**
- Scanned PDFs produce text via OCR
- Poor OCR output → document quarantined (visible, not retrievable)
- Quality assessment stored in document metadata
- Native Tesseract used if available, tesseract.js fallback

---

## Phase 2: Normalisation (parallelisable — Tasks 4, 5, 6 share only the NormalisedSection interface)

### Task 4: Section classifier

**Files:**
- Create: `src/lib/normalise/classify.ts`

- [ ] **Step 1: Implement section classification**

```typescript
export function classifySections(
  sections: ExtractedSection[],
  documentTitle: string
): NormalisedSection[]
```

Classification rules (applied in priority order):

1. **footer_header**: content matches known header/footer patterns (CONTROLLED COPY, page numbers, THIS DOCUMENT IS UNCONTROLLED) OR content matches the noise patterns list from pdf.ts
2. **form_stub**: heading matches "FORMS", "SPREADSHEETS" and content is "N/A" or empty, OR section under 10 tokens with no substantive content under a forms/appendix heading
3. **warning**: content starts with WARNING, CAUTION, NOTE, IMPORTANT (case-insensitive)
4. **procedure_step**: content matches numbered step pattern (1., 2., a), b), i., ii.) AND contains imperative verbs
5. **instruction_block**: content contains imperative verbs ("ensure", "record", "check", "verify", "place", "remove", "add", "measure", "incubate", "centrifuge") but is not step-numbered
6. **table**: type was already 'table' from extraction
7. **revision_history**: under a heading containing "revision", "amendment", "version history", "change history"
8. **appendix**: under a heading containing "appendix"
9. **metadata_only**: document control blocks (under headings like "DOCUMENT CONTROL", "APPROVAL", "DISTRIBUTION")
10. **heading**: type was 'heading' from extraction
11. **note**: short informational content under a note/reference heading
12. **paragraph**: everything else

Set `section_type_confidence` based on match strength:
- Pattern match on content: 0.9
- Inferred from heading context: 0.7
- Default/fallback: 0.5

Set `retrieval_excluded`, `retrieval_downranked`, `is_boilerplate` per the spec table:
- Exclude: footer_header, form_stub, boilerplate
- Down-rank: revision_history, appendix, metadata_only
- Include: everything else

- [ ] **Step 2: Test with real sections from a LOP extraction**

Extract a LOP PDF, run classifier, verify correct type assignment. Check: headings detected, procedures detected, warning blocks caught, watermarks classified as footer_header.

- [ ] **Step 3: Commit**

```bash
git add src/lib/normalise/classify.ts
git commit -m "feat: section type classifier with confidence scoring"
```

**Acceptance criteria:**
- Known headings classified correctly
- Watermark text → footer_header
- Numbered steps → procedure_step
- WARNING/CAUTION → warning
- Empty form sections → form_stub
- Confidence scores populated
- Exclusion/downrank flags set per spec table

---

### Task 5: Boilerplate suppression

**Files:**
- Create: `src/lib/normalise/boilerplate.ts`

- [ ] **Step 1: Implement rule-based pattern matching**

```typescript
export function isRuleBasedBoilerplate(content: string): { matched: boolean; pattern?: string }
```

Patterns (from spec 5.2):
- "CONTROLLED COPY IF THIS LINE IS GREEN"
- "THIS DOCUMENT IS UNCONTROLLED"
- Page number lines: `/^\s*(?:Page\s+)?\d+\s*(?:of\s+\d+)?\s*$/i`
- Standard PPE phrases: "wear PPE", "wash hands", "wipe down frequently", "standing for prolonged periods", "heavy lifting"
- TITAN client export header: "Name,Account Number,Account Manager,Client Type"
- Generic revision blocks matching "Version,Date,Author,Changes" patterns

- [ ] **Step 2: Implement protected content check**

```typescript
export function isProtectedContent(content: string): boolean
```

Returns `true` if content contains ANY of (spec: protected content override):
- Numeric constraints: temperatures (°C, °F), times (hours, minutes, seconds with numbers), thresholds, concentrations (mg/L, ppm, %)
- Equipment identifiers: matches known equipment names or model number patterns
- Test codes / method IDs: patterns like LOP-XX NNN, EOP NNN
- Chemical or biological terms: from a domain terms list
- Measurable conditions: "incubate", "centrifuge", "hold at", "heat to", "cool to" followed by a number

This override takes precedence over all boilerplate marking.

- [ ] **Step 3: Implement corpus fingerprinting**

```typescript
export function computeBoilerplateHash(content: string): string
// Normalise: lowercase, collapse whitespace, strip dates/page numbers/versions, SHA-256

export async function isCorpusBoilerplate(
  hash: string,
  content: string,
  threshold?: number
): Promise<boolean>
// Check boilerplate_fingerprints table for count >= threshold (default 20)
// AND verify low-information heuristic (not protected content)

export async function updateFingerprint(hash: string, sampleText: string): Promise<void>
// Upsert into boilerplate_fingerprints, increment count
```

The two-part test:
1. Frequency >= threshold
2. AND (matches rule-based pattern OR passes low-information heuristic)
3. AND NOT protected content

Low-information heuristic:
- Very low unique-term count (< 10 unique words)
- Mostly generic operational language
- No domain-specific identifiers

- [ ] **Step 4: Implement the combined suppression function**

```typescript
export async function suppressBoilerplate(
  sections: NormalisedSection[]
): Promise<NormalisedSection[]>
```

For each section:
1. If already classified as footer_header/form_stub → already excluded, skip
2. Compute boilerplate hash
3. Update fingerprint count in DB
4. Check if protected content → if yes, never mark as boilerplate
5. Check rule-based patterns → if matched AND not protected, mark boilerplate
6. Check corpus fingerprint → if frequent AND low-information AND not protected, mark boilerplate
7. Set normalisation_reason JSONB with decision traceability

- [ ] **Step 5: Test**

Test with known boilerplate (PPE text, watermark) and known protected content (procedure with temperature). Verify: PPE suppressed, temperature instruction preserved.

- [ ] **Step 6: Commit**

```bash
git add src/lib/normalise/boilerplate.ts
git commit -m "feat: boilerplate suppression with protected content override"
```

**Acceptance criteria:**
- Known boilerplate patterns detected
- Protected content with measurable conditions never suppressed
- Corpus fingerprinting updates boilerplate_fingerprints table
- Two-part test enforced (frequency + pattern/low-info)
- normalisation_reason populated for all decisions

---

### Task 6: Structural cleanup

**Files:**
- Create: `src/lib/normalise/cleanup.ts`

- [ ] **Step 1: Implement merge of adjacent tiny sections**

```typescript
export function mergeAdjacentTinySections(
  sections: NormalisedSection[],
  maxTokens?: number // default 50
): NormalisedSection[]
```

Merge adjacent sections under 50 tokens that share a parent heading. Exception: never merge across different section types.

- [ ] **Step 2: Implement empty heading removal**

```typescript
export function dropEmptyHeadings(sections: NormalisedSection[]): NormalisedSection[]
```

Remove headings whose child content (following sections until next heading of same or higher level) is all excluded.

- [ ] **Step 3: Implement within-document deduplication**

```typescript
export function deduplicateWithinDocument(sections: NormalisedSection[]): NormalisedSection[]
```

Deduplicate only when ALL conditions met:
- Exact normalised text match
- Same section_type
- Same parent heading context
- NOT procedure_step, instruction_block, or warning

Keep first occurrence with page context.

- [ ] **Step 4: Implement short content policy**

```typescript
export function applyShortContentPolicy(sections: NormalisedSection[]): NormalisedSection[]
```

Drop sections under 20 tokens only if:
- Isolated (not adjacent to a meaningful parent)
- AND section_type is not table, procedure_step, instruction_block, warning, note

- [ ] **Step 5: Commit**

```bash
git add src/lib/normalise/cleanup.ts
git commit -m "feat: structural cleanup — merge, dedup, drop empties"
```

**Acceptance criteria:**
- Adjacent tiny paragraphs merged
- Empty headings removed after boilerplate suppression
- Duplicate content collapsed (respecting safety rules)
- Meaningful short sections preserved (warnings, steps, tables)

---

### Task 7: Normalisation orchestrator

**Files:**
- Create: `src/lib/normalise/index.ts`

- [ ] **Step 1: Implement orchestrator**

```typescript
export async function normalise(
  sections: ExtractedSection[],
  documentTitle: string
): Promise<{
  sections: NormalisedSection[];
  stats: {
    total_input: number;
    total_output: number;
    excluded: number;
    downranked: number;
    boilerplate: number;
    merged: number;
    deduplicated: number;
    dropped_short: number;
  };
  sanity_warning: boolean;
}>
```

Pipeline:
1. `classifySections(sections, documentTitle)`
2. `suppressBoilerplate(classifiedSections)`
3. `mergeAdjacentTinySections(suppressed)`
4. `dropEmptyHeadings(merged)`
5. `deduplicateWithinDocument(cleaned)`
6. `applyShortContentPolicy(deduped)`
7. Run sanity check: if >80% excluded OR <3 remaining sections OR avg token count <15 → set `sanity_warning: true`
8. Return normalised sections + stats

- [ ] **Step 2: Test end-to-end with a real LOP**

Extract a LOP PDF → normalise → verify stats. Expect: significant reduction in section count, watermarks gone, procedures preserved.

- [ ] **Step 3: Commit**

```bash
git add src/lib/normalise/index.ts
git commit -m "feat: normalisation orchestrator with sanity checking"
```

**Acceptance criteria:**
- Stats accurately count each transformation
- Sanity warning triggered on heavily-excluded documents
- Full pipeline runs without errors on real corpus documents

---

## Phase 3: Compose updates (sequential — depends on Phase 2)

### Task 8: Type-aware chunkers + post-compose guardrails

**Files:**
- Modify: `src/lib/chunking/prose.ts`
- Modify: `src/lib/chunking/spreadsheet.ts`

- [ ] **Step 1: Update prose chunker for section-type awareness**

The chunker currently receives `ExtractedSection[]`. Update to accept `NormalisedSection[]`.

Rules:
- `procedure_step` and `instruction_block`: never merge into an unrelated paragraph. Start a new chunk.
- `warning` and `note`: keep as distinct chunks. Start a new chunk.
- `table`: remain atomic (existing behaviour, no change).
- Pass through section_type, exclusion flags, boilerplate_hash, normalisation_reason to PreparedChunk.
- `retrieval_excluded` sections → chunk and store but mark chunk `retrieval_excluded: true`, `embedding_status: 'skipped_excluded'`
- `retrieval_downranked` sections → chunk normally, mark chunk `retrieval_downranked: true`

- [ ] **Step 2: Add post-compose guardrail**

After chunking, filter:
- Drop chunks under 30 tokens UNLESS section_type is table, procedure_step, instruction_block, warning, or note
- Hard cap: split any chunk over 1,000 tokens regardless of structure

- [ ] **Step 3: Update spreadsheet chunker similarly**

Pass through section_type and flags. Spreadsheet chunks are rarely excluded but the interface should support it.

- [ ] **Step 4: Test chunker with normalised sections**

Run: extract a LOP → normalise → chunk. Verify:
- Procedure steps are separate chunks
- Warnings are separate chunks
- No chunks under 30 tokens (except preserved types)
- No chunks over 1,000 tokens
- Excluded sections produce chunks with retrieval_excluded=true

- [ ] **Step 5: Commit**

```bash
git add src/lib/chunking/prose.ts src/lib/chunking/spreadsheet.ts
git commit -m "feat: type-aware chunking with post-compose guardrails"
```

**Acceptance criteria:**
- procedure_step/instruction_block never merged into unrelated text
- warning/note kept as distinct chunks
- Post-compose: no chunks under 30 tokens (except preserved types)
- Post-compose: no chunks over 1,000 tokens
- Excluded sections chunked but marked retrieval_excluded

---

## Phase 4: Pipeline integration (sequential — depends on Phase 3)

### Task 9: Updated ingestion pipeline

**Files:**
- Modify: `src/lib/ingestion.ts`
- Modify: `src/lib/repositories/documents.ts`
- Modify: `src/lib/repositories/chunks.ts`

- [ ] **Step 1: Update document repository for v2 columns**

Add to `createDocument`: pipeline_version, extraction_method, text_quality_score, text_quality_tier, quality_score_source, needs_review, quarantined fields.

Add functions:
- `updateDocumentNormStats(id, { excluded_chunk_count, boilerplate_chunk_count, downranked_chunk_count })`
- `setQuarantined(id)`

Update `getHealthMetrics()` to include: quarantined_count, needs_review_count.

- [ ] **Step 2: Update chunk repository for v2 columns**

Update `insertChunksWithEmbeddings` (or create new function) to handle:
- section_type, section_type_confidence
- is_boilerplate, retrieval_excluded, retrieval_downranked
- boilerplate_hash, normalisation_reason
- embedding_status
- Nullable embedding (null for skipped_excluded chunks)

Update all retrieval queries:
- Vector search: add `AND c.retrieval_excluded = false AND c.embedding_status = 'embedded'`
- FTS search: add `AND c.retrieval_excluded = false`
- Trigram search: add `AND c.retrieval_excluded = false`

- [ ] **Step 3: Update retrieval for downrank penalty**

Modify `src/lib/retrieval.ts`:
- Read `DOWNRANK_PENALTY` from env (default 0.5)
- After score fusion, if chunk has `retrieval_downranked = true`, multiply score by penalty
- This requires the retrieval query to return `retrieval_downranked` field

- [ ] **Step 4: Update ingestion pipeline**

Modify `src/lib/ingestion.ts` processFile function to use three-stage pipeline:

```
1. Extract (existing, with quality gate for PDFs)
2. Normalise (new): call normalise(sections, docTitle)
3. If sanity_warning → set needs_review on document
4. Compose: chunk normalised sections (type-aware)
5. Separate chunks by embedding eligibility:
   - retrieval_excluded=false → embed and store
   - retrieval_excluded=true → store without embedding (embedding=null, embedding_status='skipped_excluded')
6. Update document with norm stats
7. If poor OCR + quarantined → mark quarantined
```

Update ingest_run finalisation to capture v2 metrics.

**Embedding invariant enforced:** never embed chunks where retrieval_excluded=true.

- [ ] **Step 5: Add .env.local config**

```
DOWNRANK_PENALTY=0.5
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/ingestion.ts src/lib/repositories/ src/lib/retrieval.ts
git commit -m "feat: three-stage ingestion pipeline with v2 normalisation"
```

**Acceptance criteria:**
- Pipeline runs extract → normalise → compose for every document
- Excluded chunks stored without embeddings
- Embedded chunks have embedding_status='embedded'
- Downranked chunks get score penalty in retrieval
- v2 metrics captured in ingest_runs
- Quarantined documents marked correctly
- Embedding invariant: retrieval_excluded=true never has embedding_status='embedded'

---

## Phase 5: Migration execution (sequential — depends on Phase 4)

### Task 10: Snapshot v1 + rebuild

**Files:**
- Create: `scripts/snapshot-v1.ts`
- Create: `scripts/compare-metrics.ts`

- [ ] **Step 1: Create v1 snapshot script**

```typescript
// Captures: total docs, total chunks, chunk size distribution, status breakdown
// Writes to stdout as JSON
```

Run it and save output:
```bash
npx tsx scripts/snapshot-v1.ts > /tmp/v1-snapshot.json
```

- [ ] **Step 2: Mark v1 documents inactive**

```bash
docker exec idd-knowledge-db psql -U damian -d idd_knowledge -c "
  UPDATE documents SET pipeline_version = 'v1', is_active = false WHERE pipeline_version != 'v1' OR pipeline_version IS NULL;
"
```

- [ ] **Step 3: Run v2 ingest**

```bash
npx tsx scripts/ingest.ts --force
```

Monitor progress. This will ingest all documents fresh with the v2 pipeline.

- [ ] **Step 4: Create comparison script and run it**

```typescript
// Reads v1 snapshot from file, queries v2 metrics, prints comparison table
```

```bash
npx tsx scripts/compare-metrics.ts /tmp/v1-snapshot.json
```

Verify acceptance criteria:
- < 15% of retrieval-eligible chunks under 50 tokens
- < 2% under 20 tokens (excluding preserved types)
- Average token count > 150
- Duplicate boilerplate reduced by 80%+

- [ ] **Step 5: Test retrieval quality**

Run test queries and verify retrieval density (>80% of top-10 with token_count > 100):
- "What is the MADCAP sample selection process?"
- "Describe the Mycoplasma bovis testing procedure"
- "How does result release work?"

- [ ] **Step 6: Purge v1 data**

Once satisfied:
```bash
docker exec idd-knowledge-db psql -U damian -d idd_knowledge -c "
  DELETE FROM chunks WHERE document_id IN (SELECT id FROM documents WHERE pipeline_version = 'v1');
  DELETE FROM documents WHERE pipeline_version = 'v1';
  VACUUM ANALYZE;
"
```

- [ ] **Step 7: Commit scripts**

```bash
git add scripts/snapshot-v1.ts scripts/compare-metrics.ts
git commit -m "feat: v2 rebuild complete — v1 data purged"
```

**Acceptance criteria:**
- All acceptance criteria from spec section 11 met
- v1 data cleanly purged
- v2 retrieval demonstrably better than v1

---

## Phase 6: Dashboard updates (after rebuild)

### Task 11: Update health dashboard for v2 metrics

**Files:**
- Modify: `src/app/api/docs/route.ts`
- Modify: `src/components/ingest/HealthDashboard.tsx`
- Modify: `src/components/ingest/DocumentTable.tsx`

- [ ] **Step 1: Update docs API to return v2 metrics**

Add to health response: quarantined_count, needs_review_count, pipeline_version counts.

- [ ] **Step 2: Update HealthDashboard**

Add cards: Quarantined documents, Needs Review, Quality Tiers breakdown (good/partial/poor).

- [ ] **Step 3: Update DocumentTable**

Add columns/badges: quality_tier, needs_review indicator, quarantined indicator.
Show extraction_method (native_pdf vs ocr).

- [ ] **Step 4: Test in browser**

Open /ingest, verify new metrics display correctly.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/docs/route.ts src/components/ingest/
git commit -m "feat: v2 health dashboard with quality tiers and quarantine metrics"
```

**Acceptance criteria:**
- Quarantined count visible
- Quality tier breakdown visible
- Needs-review documents highlighted
- Extraction method shown per document

---

## Parallelism Map

```
Phase 1: [Task 1] → [Task 2] → [Task 3]    (sequential — schema, quality, OCR)

Phase 2: [Task 4] ─┐
         [Task 5] ──┤  (parallel — classifier, boilerplate, cleanup)
         [Task 6] ─┘
         [Task 7]                             (sequential — orchestrator, after 4-5-6)

Phase 3: [Task 8]                             (sequential — chunker updates)

Phase 4: [Task 9]                             (sequential — pipeline integration)

Phase 5: [Task 10]                            (sequential — rebuild execution)

Phase 6: [Task 11]                            (sequential — dashboard)
```

**Subagent dispatch strategy:**
- Phase 1: one agent, sequential (Tasks 1-3 each depend on prior)
- Phase 2: 3 parallel agents for Tasks 4, 5, 6. Then 1 agent for Task 7 (orchestrator)
- Phase 3-6: one agent each, sequential
