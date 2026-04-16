# V2 Data Quality Rebuild — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the ingestion pipeline with a three-stage Extract → Normalise → Compose architecture that produces 3,000–5,000 high-quality chunks from the same 137 source documents (down from 13,005 noisy fragments).

**Architecture:** Add a normalisation stage between extraction and chunking that classifies sections, suppresses boilerplate, and applies structural cleanup. Update extractors with PDF quality gating and OCR fallback. Update chunkers to be section-type-aware. Only embed retrieval-eligible chunks.

**Tech Stack:** Existing stack (Next.js, PostgreSQL/Docker, LM Studio, tiktoken) plus tesseract.js for OCR fallback, pdfjs-dist for PDF page rendering.

**Spec:** `docs/specs/2026-04-17-v2-data-quality-rebuild.md`

---

## Agent Orchestration and Visibility in cmux

Implementation runs for the V2 rebuild use a dedicated cmux workspace so parallel agents operate in separate tabs/panes with visible task ownership, model choice, progress, and efficiency metrics.

### Workspace: `idd-v2-rebuild`

| Tab | Panes | Purpose |
|-----|-------|---------|
| **Control** | orchestrator, task status board, log tail | Coordination |
| **Extraction** | PDF quality scoring, OCR pipeline, extractor tests | Tasks 2–3 |
| **Normalisation** | classifier, boilerplate, cleanup, orchestrator | Tasks 4–7 |
| **Compose + Retrieval** | prose chunker, spreadsheet chunker, retrieval logic | Tasks 8–9 |
| **Migration + Verification** | snapshot, rebuild, metrics, DB inspection | Tasks 10–11 |
| **Browser / Dev UI** | embedded browser showing /ingest dashboard | Task 12 |

### Agent pane contract

**Required startup header:**
```
Agent: <name>
Task: <task-id>
Workspace: idd-v2-rebuild
Tab: <tab-name>
Model: <model-name>
Mode: implementation
Started: <timestamp>
Branch/Worktree: <branch>
```

**Required live status block:**
```
State: <running|blocked|review-needed|approval-required|complete>
Files touched: <n>
Tests run: <n>
Tests passed: <n>
Elapsed: <hh:mm:ss>
Tokens used: <n>
Rework count: <n>
Escalation: <none|to-model>
Last action: <summary>
```

**Required completion summary:**
```
Completed: <yes|no>
Task outcome: <passed|blocked|failed>
Model used: <model>
Model fit: <appropriate|overpowered|underpowered>
Files changed: <n>
Tests passed: <n>/<n>
Elapsed: <hh:mm:ss>
Tokens used: <n>
Open issues: <summary>
```

### Model selection policy

| Model | Use for |
|-------|---------|
| gpt-oss-20b | PDF quality scoring, OCR routing, classifier logic, boilerplate suppression, migration safety, retrieval changes, pipeline integration |
| qwen3.5-9b | Cleanup logic, chunker plumbing, repository updates, dashboard updates, API wiring, straightforward refactors |

**Escalation rules:** Escalate to stronger model when: agent fails same test twice without progress, loops on same logic path, misses explicit constraints, or produces structurally weak logic for classification/OCR/retrieval.

### Notification policy

Use cmux notification rings to surface panes needing attention:
- Task completes
- Tests fail twice
- Migration step ready for approval
- Rebuild metrics miss acceptance thresholds
- Model escalation triggered

### Logging

Each pane writes a task log to `/tmp/idd-v2/task-N-<name>.log` containing: header, model used, start time, actions, tests, failures, escalations, completion summary.

### Efficiency review at end of run

The orchestrator produces a post-run summary: which models used per task, escalation count, efficient pairings, rework-heavy pairings, recommendations for next run.

### Task-to-pane mapping

| Task | Tab | Model |
|------|-----|-------|
| 1 — Schema + types | Migration + Verification | gpt-oss-20b |
| 2 — PDF quality scoring | Extraction | gpt-oss-20b |
| 3 — OCR pipeline | Extraction | gpt-oss-20b |
| 4 — Section classifier | Normalisation | gpt-oss-20b |
| 5 — Boilerplate suppression | Normalisation | gpt-oss-20b |
| 6 — Structural cleanup | Normalisation | qwen3.5-9b (escalate if needed) |
| 7 — Normalisation orchestrator | Normalisation | gpt-oss-20b |
| 8 — Type-aware chunkers | Compose + Retrieval | qwen3.5-9b |
| 9 — Pipeline integration | Compose + Retrieval | gpt-oss-20b |
| 10 — Snapshot + rebuild + compare | Migration + Verification | gpt-oss-20b |
| 11 — Cutover + purge + verify | Migration + Verification | gpt-oss-20b |
| 12 — Dashboard updates | Browser / Dev UI | qwen3.5-9b |

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
| `scripts/golden-queries.json` | Test queries with expected behaviours |

### Modified files
| File | Changes |
|------|---------|
| `src/lib/types.ts` | Add NormalisedSection, SectionType, update PreparedChunk, DocumentRow, HealthMetrics, IngestRunResult |
| `src/lib/extraction/pdf.ts` | Add quality gate call, route to OCR on poor quality |
| `src/lib/chunking/prose.ts` | Section-type awareness: respect procedure_step, warning, instruction_block boundaries |
| `src/lib/chunking/spreadsheet.ts` | Section-type awareness: mark excluded/downranked |
| `src/lib/ingestion.ts` | Three-stage pipeline, two-pass fingerprinting, embedding policy, v2 metrics |
| `src/lib/repositories/documents.ts` | New v2 columns in CRUD, health metrics for quarantined/v2 counts |
| `src/lib/repositories/chunks.ts` | Retrieval queries add exclusion filters, downrank penalty |
| `src/lib/retrieval.ts` | Apply DOWNRANK_PENALTY to downranked chunks |
| `src/app/api/docs/route.ts` | Expose v2 health metrics |
| `src/components/ingest/HealthDashboard.tsx` | Show quarantined count, quality tiers |
| `src/components/ingest/DocumentTable.tsx` | Quality tier column, extraction_method |

---

## Phase 1: Foundation (Task 1 first, then Tasks 2-3 can parallel)

### Task 1: Schema migration + type updates

**Files:**
- Create: `db/migrations/002_v2_data_quality.sql`
- Modify: `src/lib/types.ts`

- [ ] **Step 0: Verify v1 schema**

Before applying migration, confirm expected v1 columns/indexes exist:

```bash
docker exec idd-knowledge-db psql -U damian -d idd_knowledge -c "
  SELECT column_name FROM information_schema.columns WHERE table_name = 'documents' AND column_name IN ('ocr_used', 'updated_at', 'source_missing');
  SELECT indexname FROM pg_indexes WHERE indexname = 'ux_documents_active_source_path';
  SELECT tablename FROM pg_tables WHERE tablename = 'ingest_runs';
"
```

Expected: all three columns present, unique index exists, ingest_runs table exists. If any are missing, adjust migration accordingly.

- [ ] **Step 1: Create migration file**

Full SQL from spec section 7.1:
- documents: pipeline_version, extraction_method, text_quality_score, text_quality_tier, quality_score_source, needs_review, excluded_chunk_count, boilerplate_chunk_count, downranked_chunk_count, quarantined
- chunks: section_type, section_type_confidence, is_boilerplate, retrieval_excluded, retrieval_downranked, boilerplate_hash, embedding_status (default 'pending'), normalisation_reason JSONB
- chunks.embedding DROP NOT NULL
- boilerplate_fingerprints table (hash PK, sample_text, occurrence_count, is_confirmed_boilerplate, last_seen_at)
- ingest_runs v2 columns: ocr_routed_count, quarantined_count, excluded_chunk_count, downranked_chunk_count, embedded_chunk_count, skipped_embedding_count, pipeline_version
- All CHECK constraints (text_quality_tier, extraction_method, quality_score_source, embedding_status, section_type)
- Partial vector index replacing old full index

- [ ] **Step 2: Run migration**

```bash
docker exec -i idd-knowledge-db psql -U damian -d idd_knowledge < db/migrations/002_v2_data_quality.sql
```

Verify: `\d documents`, `\d chunks`, `\d boilerplate_fingerprints` show new columns/tables.

- [ ] **Step 3: Update src/lib/types.ts**

Add `SectionType` union type, `NormalisedSection` interface extending `ExtractedSection`.

Update `ExtractedSection.type` to include `'instruction_block'`.

Update `PreparedChunk` to add: section_type, is_boilerplate, retrieval_excluded, retrieval_downranked, boilerplate_hash, normalisation_reason, embedding_status.

Update `DocumentRow` to add all new document columns.

Update `HealthMetrics` to add: quarantined_count, needs_review_count.

Update `IngestRunResult` to add: ocr_routed, quarantined, excluded_chunks, downranked_chunks, embedded_chunks, skipped_embeddings.

- [ ] **Step 4: Commit**

```bash
git add db/migrations/002_v2_data_quality.sql src/lib/types.ts
git commit -m "feat: v2 schema migration and type definitions"
```

**Acceptance criteria:**
- Migration runs without errors on top of v1 schema
- All CHECK constraints active
- New columns have correct defaults
- boilerplate_fingerprints table exists
- NormalisedSection and SectionType types compile

---

### Task 2: PDF quality scoring

**Files:**
- Create: `src/lib/extraction/pdf-quality.ts`

*Can run in parallel with Task 3 after Task 1 completes.*

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

Scoring signals (spec 4.1):
- Printable/alphanumeric ratio (weight 0.25)
- Average token length sanity (weight 0.20) — penalise <2 or >12 chars mean
- Dictionary/domain-term hit rate (weight 0.25)
- Proportion of pages with usable text (weight 0.15)
- Suspicious character/token pattern rate (weight 0.15) — excessive punctuation sequences, repeated single chars, mixed alpha-numeric gibberish

Tiers: good (>0.8), partial (0.4–0.8), poor (<0.4).

- [ ] **Step 2: Build domain terms list**

An inline constant of ~100 MTNZ-specific terms seeded from knowledge of the project (not dependent on DOM-GLOSS file): equipment names (MilkoScan, BactoScan, CombiFoss, CryoScope, ILAS), system names (MADCAP, TITAN, LIMS), organisations (MPI, IANZ, OSPRI), test types (coliform, thermoduric, somatic cell), chemical/biological terms (M. bovis, beta-lactam, aflatoxin). Optionally extend later from DOM-GLOSS if available.

- [ ] **Step 3: Test with known good and bad data**

Test against a text-rich LOP PDF (expect: good), near-empty text (expect: poor), and random binary-like text (expect: poor).

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
- Modify: `src/lib/extraction/pdf.ts`
- Modify: `package.json`

*Can run in parallel with Task 2 after Task 1 completes.*

- [ ] **Step 1: Install dependencies**

```bash
npm install tesseract.js pdfjs-dist
```

Use **pdfjs-dist** for PDF page rendering (decided — not pdf-to-img).

- [ ] **Step 2: Implement OCR extraction**

```typescript
export async function ocrPdf(
  buffer: Buffer,
  filename: string,
  onPageProgress?: (page: number, total: number) => void
): Promise<ExtractedContent>
```

Pipeline:
1. Render PDF pages to images using pdfjs-dist canvas API
2. For each page image, run Tesseract OCR
3. Collect per-page text with page numbers
4. Run section detection on OCR text (share detection logic with pdf.ts)
5. Return ExtractedContent with `ocr_used: true`

**Tesseract path resolution:** Use `which tesseract` first. If native binary found, prefer it. Otherwise fall back to tesseract.js. Do not hardcode paths like `/usr/local/bin/tesseract`.

Handle failure gracefully: if OCR produces nothing usable, return ExtractedContent with empty sections and metadata indicating failure.

- [ ] **Step 3: Integrate quality gate into PDF extractor**

Modify `src/lib/extraction/pdf.ts`:
1. After native text extraction, call `assessTextQuality()`
2. If tier is 'poor' → call `ocrPdf()` instead, re-assess quality on OCR output
3. If tier is 'partial' → proceed with native text, set `needs_review: true` in metadata
4. If poor OCR output:
   - Store OCR output anyway (do not discard)
   - Set metadata: `text_quality_tier: 'poor'`, `needs_review: true`, `quarantine: true`
   - All chunks from this document will be marked `retrieval_excluded: true`
5. Store quality assessment results in ExtractedContent metadata

- [ ] **Step 4: Test quarantine path explicitly**

Force a known poor-quality document through the OCR path. Verify:
- `quarantined = true`
- `needs_review = true`
- All chunks from it would have `retrieval_excluded = true`
- `embedding_status != 'embedded'` for those chunks

This is a key v2 behaviour and must have a direct test.

- [ ] **Step 5: Commit**

```bash
git add src/lib/extraction/ocr.ts src/lib/extraction/pdf.ts package.json package-lock.json
git commit -m "feat: OCR pipeline with quality-gated PDF extraction"
```

**Acceptance criteria:**
- Scanned PDFs produce text via OCR
- Poor OCR output → document quarantined (visible, not retrievable, reprocessable)
- Quality assessment stored in document metadata
- Native Tesseract used if available (via `which`), tesseract.js fallback
- pdfjs-dist used for page rendering
- Quarantine path explicitly tested

---

## Phase 2: Normalisation (Tasks 4, 5, 6 parallelisable; Task 7 after all three)

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

Classification rules (applied in priority order — note table is ABOVE instruction_block to avoid misclassifying tabular imperative text):

1. **footer_header**: matches known header/footer patterns (CONTROLLED COPY, page numbers, THIS DOCUMENT IS UNCONTROLLED)
2. **form_stub**: heading matches "FORMS", "SPREADSHEETS" and content is "N/A" or empty
3. **warning**: content starts with WARNING, CAUTION, NOTE, IMPORTANT (case-insensitive)
4. **procedure_step**: numbered step pattern (1., 2., a), b)) AND imperative verbs
5. **table**: type was already 'table' from extraction
6. **instruction_block**: imperative verbs ("ensure", "record", "check", "verify", "place", "remove", "add", "measure", "incubate", "centrifuge") but NOT step-numbered
7. **revision_history**: under heading containing "revision", "amendment", "version history"
8. **appendix**: under heading containing "appendix"
9. **metadata_only**: under headings like "DOCUMENT CONTROL", "APPROVAL", "DISTRIBUTION"
10. **heading**: type was 'heading' from extraction
11. **note**: short informational content under note/reference heading
12. **paragraph**: everything else

Set `section_type_confidence`: pattern match on content → 0.9, inferred from heading → 0.7, fallback → 0.5.

Set flags per spec table:
- Exclude: footer_header, form_stub, boilerplate
- Down-rank: revision_history, appendix, metadata_only
- Include: everything else

- [ ] **Step 2: Test with real LOP sections**

Extract a LOP PDF, run classifier. Verify: watermarks → footer_header, numbered steps → procedure_step, WARNING blocks → warning, empty forms → form_stub.

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
- Table classified before instruction_block (priority order)
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

Patterns from spec: CONTROLLED COPY, UNCONTROLLED DOCUMENT, page number lines, standard PPE phrases, TITAN client export header, generic revision block patterns.

- [ ] **Step 2: Implement protected content check**

```typescript
export function isProtectedContent(content: string): boolean
```

Returns `true` if content contains ANY of:
- Numeric constraints (temperatures °C/°F, times with numbers, concentrations mg/L/ppm/%)
- Equipment identifiers (known equipment names or model number patterns)
- Test codes / method IDs (LOP-XX NNN, EOP NNN patterns)
- Chemical or biological terms (from domain terms list)
- Measurable conditions ("incubate", "centrifuge", "hold at", "heat to" followed by number)

**This override takes precedence over all boilerplate marking.**

- [ ] **Step 3: Implement corpus fingerprinting**

```typescript
export function computeBoilerplateHash(content: string): string
export async function getFingerprint(hash: string): Promise<{ count: number; confirmed: boolean } | null>
export async function updateFingerprint(hash: string, sampleText: string): Promise<void>
```

**Critical: fingerprint counting and suppression must use stable counts.**

For the rebuild run (two-pass approach):
- **Pass 1 (pre-scan):** Extract + classify all documents, compute fingerprints, update counts in boilerplate_fingerprints table. Do NOT apply corpus-level suppression yet.
- **Pass 2 (normalise):** Apply suppression using the now-stable corpus counts.

For steady-state incremental ingestion (after rebuild):
- Use rule-based suppression immediately
- Use corpus-frequency suppression only against existing stable counts from prior runs (not live incremented counts from the current run)

The two-part test for corpus suppression:
1. Frequency >= threshold (default 20)
2. AND (matches rule-based pattern OR passes low-information heuristic)
3. AND NOT protected content

Low-information heuristic: very low unique-term count (<10 unique words), mostly generic language, no domain-specific identifiers.

- [ ] **Step 4: Implement combined suppression function**

```typescript
export async function suppressBoilerplate(
  sections: NormalisedSection[],
  mode: 'rebuild' | 'incremental'
): Promise<NormalisedSection[]>
```

For each section:
1. If already footer_header/form_stub → already excluded, skip
2. Compute boilerplate hash
3. Check protected content → if yes, never mark boilerplate, set `normalisation_reason: { protected: true, reason: "contains_measurable_condition" }`
4. Check rule-based patterns → if matched AND not protected, mark boilerplate
5. If mode='rebuild': check corpus fingerprint with stable counts → if frequent AND low-information AND not protected, mark boilerplate
6. Set normalisation_reason JSONB with decision traceability

- [ ] **Step 5: Test**

Test with: PPE text (should suppress), watermark (should suppress), procedure with "incubate at 37°C for 24h" appearing 25+ times (should NOT suppress — protected content).

- [ ] **Step 6: Commit**

```bash
git add src/lib/normalise/boilerplate.ts
git commit -m "feat: boilerplate suppression with protected content override"
```

**Acceptance criteria:**
- Known boilerplate patterns detected and suppressed
- Protected content with measurable conditions NEVER suppressed
- Repeated PPE text excluded
- Repeated technical instruction with numeric condition preserved
- Corpus fingerprinting updates boilerplate_fingerprints table
- Two-part test enforced (frequency + pattern/low-info)
- normalisation_reason populated for all decisions
- Rebuild mode uses stable counts (not live increments)

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

Merge adjacent sections under 50 tokens that share a parent heading. Never merge across different section types.

- [ ] **Step 2: Implement empty heading removal**

```typescript
export function dropEmptyHeadings(sections: NormalisedSection[]): NormalisedSection[]
```

Remove headings whose child content is all excluded after suppression.

- [ ] **Step 3: Implement within-document deduplication**

```typescript
export function deduplicateWithinDocument(sections: NormalisedSection[]): NormalisedSection[]
```

Deduplicate only when ALL conditions met:
- Exact normalised text match
- Same section_type
- Same parent heading context
- NOT procedure_step, instruction_block, or warning

- [ ] **Step 4: Implement short content policy**

```typescript
export function applyShortContentPolicy(sections: NormalisedSection[]): NormalisedSection[]
```

Drop under 20 tokens only if: isolated AND section_type is not table, procedure_step, instruction_block, warning, note.

- [ ] **Step 5: Commit**

```bash
git add src/lib/normalise/cleanup.ts
git commit -m "feat: structural cleanup — merge, dedup, drop empties"
```

**Acceptance criteria:**
- Adjacent tiny paragraphs merged
- Empty headings removed after suppression
- Duplicate content collapsed (respecting safety rules)
- Meaningful short sections preserved (warnings, steps, tables)
- procedure_step and warning never deduplicated

---

### Task 7: Normalisation orchestrator

**Files:**
- Create: `src/lib/normalise/index.ts`

*Depends on Tasks 4, 5, 6 being complete.*

- [ ] **Step 1: Implement orchestrator**

```typescript
export async function normalise(
  sections: ExtractedSection[],
  documentTitle: string,
  mode: 'rebuild' | 'incremental'
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
2. `suppressBoilerplate(classifiedSections, mode)`
3. `mergeAdjacentTinySections(suppressed)`
4. `dropEmptyHeadings(merged)`
5. `deduplicateWithinDocument(cleaned)`
6. `applyShortContentPolicy(deduped)`
7. Compute stats from **final** section states (after all transformations complete)
8. Sanity check: if >80% excluded OR <3 remaining sections OR avg token count <15 → `sanity_warning: true`

- [ ] **Step 2: Test end-to-end with a real LOP**

Extract LOP-MC 001 → normalise → verify stats. Expect: significant reduction, watermarks gone, procedures preserved, stats accurate.

- [ ] **Step 3: Commit**

```bash
git add src/lib/normalise/index.ts
git commit -m "feat: normalisation orchestrator with sanity checking"
```

**Acceptance criteria:**
- Stats accurately count each transformation from final states
- Sanity warning triggered on heavily-excluded documents
- Full pipeline runs without errors on real corpus documents

---

## Phase 3: Compose updates (depends on Phase 2)

### Task 8: Type-aware chunkers + post-compose guardrails

**Files:**
- Modify: `src/lib/chunking/prose.ts`
- Modify: `src/lib/chunking/spreadsheet.ts`

- [ ] **Step 1: Update prose chunker for section-type awareness**

Update to accept `NormalisedSection[]` instead of `ExtractedSection[]`.

Rules:
- `procedure_step` and `instruction_block`: never merge into an unrelated paragraph — start a new chunk
- `warning` and `note`: keep as distinct chunks — start a new chunk
- `table`: remain atomic (existing, no change)
- Pass through: section_type, is_boilerplate, retrieval_excluded, retrieval_downranked, boilerplate_hash, normalisation_reason to PreparedChunk
- `retrieval_excluded` sections → chunk and store, mark chunk `retrieval_excluded: true`, `embedding_status: 'skipped_excluded'`
- `retrieval_downranked` sections → chunk normally, mark `retrieval_downranked: true`

**Mixed section types in merged chunks:** When a chunk contains multiple merged normalised sections, set chunk `section_type` to the first structural driver section's type. Record `metadata.section_types` as an array of all contributing types. This avoids ambiguity in retrieval filtering.

- [ ] **Step 2: Add post-compose guardrail**

After chunking:
- Drop retrieval-bearing chunks under 30 tokens UNLESS section_type is table, procedure_step, instruction_block, warning, or note
- **Do NOT drop excluded chunks solely for being short** — they are stored for audit visibility regardless of size
- Hard cap: split any chunk over 1,000 tokens regardless of structure

- [ ] **Step 3: Update spreadsheet chunker similarly**

Pass through section_type and flags. Mark excluded/downranked as appropriate.

- [ ] **Step 4: Test chunker with normalised sections**

Extract LOP → normalise → chunk. Verify:
- Procedure steps are separate chunks
- Warnings are separate chunks (preserved intact after chunking)
- No retrieval-bearing chunks under 30 tokens (except preserved types)
- No chunks over 1,000 tokens
- Excluded sections produce chunks with retrieval_excluded=true
- Chunk metadata carries exclusion/downrank flags correctly
- Mixed-section chunks have metadata.section_types array

- [ ] **Step 5: Commit**

```bash
git add src/lib/chunking/prose.ts src/lib/chunking/spreadsheet.ts
git commit -m "feat: type-aware chunking with post-compose guardrails"
```

**Acceptance criteria:**
- procedure_step/instruction_block never merged into unrelated text
- warning/note kept as distinct chunks
- Post-compose: no retrieval-bearing chunks under 30 tokens (except preserved types)
- Post-compose: no chunks over 1,000 tokens
- Excluded sections chunked but marked retrieval_excluded
- Audit chunks not dropped for being short
- Mixed-section chunk type resolved deterministically

---

## Phase 4: Pipeline integration (depends on Phase 3)

### Task 9: Updated ingestion pipeline + repositories + retrieval

**Files:**
- Modify: `src/lib/ingestion.ts`
- Modify: `src/lib/repositories/documents.ts`
- Modify: `src/lib/repositories/chunks.ts`
- Modify: `src/lib/retrieval.ts`

- [ ] **Step 1: Update document repository for v2 columns**

Add to `createDocument`: pipeline_version, extraction_method, text_quality_score, text_quality_tier, quality_score_source, needs_review, quarantined.

Add functions:
- `updateDocumentNormStats(id, { excluded_chunk_count, boilerplate_chunk_count, downranked_chunk_count })`
- `setQuarantined(id)`

Update `getHealthMetrics()`: add quarantined_count, needs_review_count.

Document-level chunk counts (excluded, boilerplate, downranked) are **stored chunk counts after compose**, not pre-compose section counts.

- [ ] **Step 2: Update chunk repository for v2 columns and embedding policy**

Update insert function to handle:
- section_type, section_type_confidence, is_boilerplate, retrieval_excluded, retrieval_downranked, boilerplate_hash, normalisation_reason, embedding_status
- Nullable embedding (null for skipped_excluded chunks)

Update retrieval queries:
- Vector search: `AND c.retrieval_excluded = false AND c.embedding_status = 'embedded'`
- FTS search: `AND c.retrieval_excluded = false`
- Trigram search: `AND c.retrieval_excluded = false`

Return `retrieval_downranked` field in all search results.

- [ ] **Step 3: Update retrieval for downrank penalty**

Modify `src/lib/retrieval.ts`:
- Read `DOWNRANK_PENALTY` from env (default 0.5)
- After score fusion, if chunk has `retrieval_downranked = true`, multiply final score by penalty

- [ ] **Step 4: Update ingestion pipeline for three-stage processing**

Modify processFile in `src/lib/ingestion.ts`:

```
1. Extract (existing, with quality gate for PDFs)
2. Normalise: call normalise(sections, docTitle, mode)
   - mode = 'rebuild' for full re-ingest, 'incremental' for normal ingest
3. If sanity_warning → set needs_review on document
4. Compose: chunk normalised sections (type-aware)
5. Separate chunks by embedding eligibility:
   - retrieval_excluded=false → embed and store (embedding_status='embedded')
   - retrieval_excluded=true → store without embedding (embedding=null, embedding_status='skipped_excluded')
6. Update document norm stats (counts are stored chunk counts after compose)
7. If poor OCR + quarantine metadata → setQuarantined(id)
```

**Invariant: document row not marked complete until chunks are stored and embedding states finalised.**

**Embedding invariant: retrieval_excluded=true must never have embedding_status='embedded'.**

**Two-pass rebuild mode:** For full rebuild, the ingestion pipeline runs:
- Pass 1: extract + classify + compute fingerprints for all documents (no normalise/compose yet)
- Pass 2: normalise + compose + embed + store for all documents (using stable fingerprint counts)

For incremental mode (normal use after rebuild), single-pass with rule-based suppression and existing stable fingerprint counts.

Update ingest_run finalisation with v2 metrics: ocr_routed_count, quarantined_count, excluded_chunk_count, downranked_chunk_count, embedded_chunk_count, skipped_embedding_count.

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
- Excluded chunks stored without embeddings (embedding=null)
- Embedded chunks have non-null embedding vectors and embedding_status='embedded'
- Downranked chunks get score penalty in retrieval
- v2 metrics captured in ingest_runs
- Quarantined documents marked correctly and produce zero retrievable chunks
- Embedding invariant enforced: retrieval_excluded=true never 'embedded'
- Document not marked complete until chunks stored and embedding states final
- Two-pass mode works for rebuild
- Single-pass mode works for incremental

---

## Phase 5: Migration execution

### Task 10: Snapshot + rebuild + compare

**Files:**
- Create: `scripts/snapshot-v1.ts`
- Create: `scripts/compare-metrics.ts`
- Create: `scripts/golden-queries.json`

- [ ] **Step 1: Create v1 snapshot script**

Captures: total docs, total chunks, chunk size distribution (buckets), extraction status breakdown, avg token count.

```bash
npx tsx scripts/snapshot-v1.ts > /tmp/v1-snapshot.json
```

- [ ] **Step 2: Create golden queries fixture**

```json
[
  { "query": "What is the MADCAP sample selection process?", "expected_docs": ["2.0-Sample Selection", "LOP-MC 001"], "type": "procedural" },
  { "query": "Describe the Mycoplasma bovis testing procedure", "expected_docs": ["LOP-AH 002"], "type": "procedural" },
  { "query": "How does result release work?", "expected_docs": ["LOP-RR 001"], "type": "procedural" },
  { "query": "BactoScan configuration and operation", "expected_docs": ["EOP"], "type": "equipment" },
  { "query": "IANZ accreditation requirements", "expected_docs": ["LOP-QM"], "type": "compliance" },
  { "query": "What is the CEO's birthday?", "expected_behaviour": "no_evidence", "type": "grounded_refusal" },
  { "query": "LOP-MC 001", "expected_docs": ["LOP-MC 001"], "type": "exact_match" }
]
```

- [ ] **Step 3: Mark v1 documents inactive**

```sql
UPDATE documents
SET pipeline_version = 'v1', is_active = false, updated_at = now()
WHERE is_active = true;
```

Note: constrain to currently active documents only. Do not touch already-inactive rows.

- [ ] **Step 4: Run v2 ingest (rebuild mode)**

```bash
npx tsx scripts/ingest.ts --force --rebuild
```

(Add `--rebuild` flag to ingestion.ts to trigger two-pass mode.)

Monitor progress.

- [ ] **Step 5: Verify no source path has more than one active row**

```sql
SELECT source_path, count(*) FROM documents WHERE is_active = true GROUP BY source_path HAVING count(*) > 1;
```

Expected: 0 rows.

- [ ] **Step 6: Create comparison script and run**

```bash
npx tsx scripts/compare-metrics.ts /tmp/v1-snapshot.json
```

Verify acceptance criteria:
- < 15% of retrieval-eligible chunks under 50 tokens
- < 2% under 20 tokens (excluding preserved types)
- Average token count > 150
- Duplicate boilerplate reduced by 80%+
- Retrieval density: >80% of top-10 results with token_count > 100

- [ ] **Step 7: Test golden queries**

Run each query from golden-queries.json through hybridSearch. Verify expected docs appear in results and excluded content does not.

- [ ] **Step 8: Commit scripts**

```bash
git add scripts/snapshot-v1.ts scripts/compare-metrics.ts scripts/golden-queries.json
git commit -m "feat: v2 rebuild scripts and golden query fixtures"
```

**Acceptance criteria:**
- All acceptance criteria from spec section 11 met
- No source path has >1 active document
- Golden queries return expected source documents
- Excluded chunks never appear in normal retrieval
- Retrieval top results no longer dominated by watermark/header content

---

### Task 11: Cutover + purge + verify

**Files:**
- No new files — operational task

- [ ] **Step 1: Final verification queries**

```sql
-- Confirm v2 is active, v1 is inactive
SELECT pipeline_version, is_active, count(*) FROM documents GROUP BY pipeline_version, is_active;

-- Confirm no active v1 docs remain
SELECT count(*) FROM documents WHERE pipeline_version = 'v1' AND is_active = true;
-- Expected: 0
```

- [ ] **Step 2: Purge v1 data**

```sql
DELETE FROM chunks WHERE document_id IN (SELECT id FROM documents WHERE pipeline_version = 'v1');
DELETE FROM documents WHERE pipeline_version = 'v1';
```

- [ ] **Step 3: Run ANALYZE separately**

```sql
ANALYZE chunks;
ANALYZE documents;
ANALYZE boilerplate_fingerprints;
```

Optionally VACUUM outside the main script if needed.

- [ ] **Step 4: Final count verification**

```sql
SELECT count(*) as total_docs FROM documents WHERE is_active = true;
SELECT count(*) as total_chunks FROM chunks WHERE retrieval_excluded = false;
SELECT count(*) as excluded_chunks FROM chunks WHERE retrieval_excluded = true;
SELECT avg(token_count) as avg_tokens FROM chunks WHERE retrieval_excluded = false;
```

- [ ] **Step 5: Commit any remaining changes**

```bash
git add -A && git commit -m "feat: v2 rebuild complete — v1 data purged"
```

**Acceptance criteria:**
- No v1 documents or chunks remain
- Active v2 document count matches expected corpus size
- Average token count for retrieval-eligible chunks > 150
- ANALYZE completed for all tables

---

## Phase 6: Dashboard updates

### Task 12: Update health dashboard for v2 metrics

**Files:**
- Modify: `src/app/api/docs/route.ts`
- Modify: `src/components/ingest/HealthDashboard.tsx`
- Modify: `src/components/ingest/DocumentTable.tsx`

- [ ] **Step 1: Update docs API to return v2 metrics**

Add to health response: quarantined_count, needs_review_count, pipeline_version counts.

- [ ] **Step 2: Update HealthDashboard**

Add cards: Quarantined documents, Needs Review, Quality Tiers breakdown (good/partial/poor).

Quarantined is NOT just a badge variant of needs-review — quarantined documents have harder handling (all chunks excluded from retrieval). Show them separately.

- [ ] **Step 3: Update DocumentTable**

Add columns/badges: quality_tier, needs_review indicator, quarantined indicator, extraction_method (native_pdf vs ocr).

- [ ] **Step 4: Test in browser**

Open /ingest, verify new metrics display correctly against v2 data.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/docs/route.ts src/components/ingest/
git commit -m "feat: v2 health dashboard with quality tiers and quarantine metrics"
```

**Acceptance criteria:**
- Quarantined count visible and separate from needs-review
- Quality tier breakdown visible (good/partial/poor)
- Needs-review documents highlighted
- Extraction method shown per document

---

## Parallelism Map

```
Phase 1: [Task 1] → [Task 2] ─┐  (Tasks 2-3 parallel after Task 1)
                    [Task 3] ─┘

Phase 2: [Task 4] ─┐
         [Task 5] ──┤  (parallel — classifier, boilerplate, cleanup)
         [Task 6] ─┘
             ↓
         [Task 7]    (sequential — orchestrator needs 4, 5, 6)

Phase 3: [Task 8]    (sequential — chunker updates)

Phase 4: [Task 9]    (sequential — pipeline integration)

Phase 5: [Task 10] → [Task 11]  (sequential — rebuild then cutover)

Phase 6: [Task 12]   (sequential — dashboard)
```

**Subagent dispatch strategy:**
- Phase 1: Task 1 first, then Tasks 2+3 in parallel
- Phase 2: Tasks 4, 5, 6 in parallel, then Task 7
- Phase 3–6: one agent each, sequential
