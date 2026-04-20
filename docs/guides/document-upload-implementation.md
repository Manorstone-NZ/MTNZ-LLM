# Document Upload Feature Implementation Guide

**Date:** April 2026  
**Status:** Implemented  
**Component:** Frontend file upload + backend ingestion integration

---

## Overview

The document upload feature enables operators to add new documents to the knowledge base directly from the browser UI without requiring command-line access. All documents uploaded are processed through the complete V2 ingestion pipeline with all existing quality rules applied.

### Architecture

```
┌─ Browser (Ingest Page)
│  └─ File Select/Drag-Drop
│     └─ Validation (format, size)
│        └─ POST /api/ingest/upload
│           ↓
│  ┌─ Server (Next.js)
│  │  └─ Save file to ./uploads/
│  │     └─ Return success
│  │        ↓
│  └─ Browser
│     └─ Trigger ingest via POST /api/ingest
│        └─ Full V2 Pipeline
│           ├─ Extract
│           ├─ Normalize
│           ├─ Chunk
│           ├─ Embed
│           └─ Store
│        └─ SSE progress stream
│           ↓
│  Browser receives events
│  └─ Update UI with status
     └─ Refresh document table
```

---

## Features Implemented

### 1. Frontend Upload UI (`src/app/ingest/page.tsx`)

**Components:**
- **Upload Area** — Drag-and-drop zone for files
  - Click to browse file picker
  - Drag files directly into zone
  - Visual feedback (color change on drag)
  - Supported formats listed
  - File size limit (100MB) noted

- **File Validation**
  - Extension check against `SUPPORTED_EXTENSIONS`
  - Size validation (100MB max)
  - User-friendly error messages
  - Multiple file support

- **Upload Progress**
  - Real-time progress bar
  - Current file name displayed
  - Percent complete (0-100%)
  - Displays "Processing..." after upload completes

- **Integration with Existing UI**
  - Error banner for upload failures
  - Disables controls during processing
  - Auto-refreshes document table on completion
  - Uses existing SSE progress handling

**Supported Formats:**
```
PDF, DOCX, XLSX, TXT, PNG, JPG, JPEG, GIF, BMP, WEBP, TIF, TIFF
```

### 2. File Upload API (`src/app/api/ingest/upload/route.ts`)

**Endpoint:** `POST /api/ingest/upload`

**Input:** Form data with `file` field

**Validation:**
- File extension validation (must be in `SUPPORTED_EXTENSIONS`)
- File size validation (max 100MB)
- Readable file content required

**Processing:**
- Generates unique filename with timestamp + UUID
  - Format: `{timestamp}-{uniqueId}-{basename}{ext}`
  - Example: `1713571234000-a1b2c3d4-budget.pdf`
- Writes to disk at `./uploads/` (configurable via `UPLOAD_DIR`)
- Returns success with metadata (filename, size, saved path)

**Error Handling:**
- 400: Invalid format or file too large
- 500: I/O or internal error

**Response:**
```json
{
  "ok": true,
  "file": "original-name.pdf",
  "savedAs": "1713571234000-a1b2c3d4-original-name.pdf",
  "path": "./uploads/1713571234000-a1b2c3d4-original-name.pdf",
  "size": 1024000
}
```

### 3. Ingestion Pipeline Integration (`src/lib/ingestion.ts`)

**Changes:**
- Scans both `SOURCE_PATH` and `./uploads/` directory
- Prefixes uploaded files as `uploads/{filename}` for tracking
- Handles missing uploads directory gracefully
- Processes uploaded files through full V2 pipeline

**Processing:**
1. File uploaded → Saved to `./uploads/`
2. Trigger `/api/ingest` with `forceReprocess: true`
3. Pipeline scans `./uploads/` for new files
4. Files processed through:
   - Extraction (native/OCR routing)
   - Normalization (boilerplate detection)
   - Chunking (semantic + type-aware)
   - Embedding (vector generation)
   - Storage (database insertion)
5. SSE stream sends progress to browser
6. Document table refreshes automatically

### 4. Documentation

#### User Guide (`docs/guides/adding-documents.md`)
- Quick-start instructions (5-minute read)
- Phase-by-phase pipeline explanation
- Quality indicators interpretation
- Chunk count understanding
- Troubleshooting section
- FAQ

**Key Sections:**
- Upload process overview
- What happens in each phase (extraction, normalization, chunking, embedding)
- Quality tier meanings (good/partial/poor)
- Extraction method explanations
- Chunk count breakdown
- Best practices for different file types

#### Developer Guide (`docs/guides/ingestion-pipeline-internals.md`)
- Complete pipeline architecture
- 14 core ingestion rules explained
- Configuration options
- Performance characteristics
- Testing checklist
- Extension points for developers

**Key Sections:**
- Architecture overview
- Stage 1: Extraction rules
- Stage 2: Normalization rules
- Stage 3: Chunking & embedding rules
- PDF completeness trust audit
- Integration points
- Troubleshooting & extension

---

## Configuration

### Environment Variables

```bash
# Upload directory (where files are saved)
UPLOAD_DIR=./uploads

# Ingestion pipeline (existing)
INGEST_FILE_CONCURRENCY=2
EMBED_BATCH_SIZE=50
DOWNRANK_PENALTY=0.5

# Feature flags (existing)
ENABLE_BOILERPLATE_DETECTION=true
ENABLE_SANITY_WARNINGS=true
ENABLE_PDF_AUDIT=true
```

### File Locations

- **Source directory:** `$SOURCE_PATH` (existing, e.g., `/data/idd`)
- **Upload directory:** `$UPLOAD_DIR` (new, defaults to `./uploads`)
- **Documents scanned from:** Both locations (merged)
- **Uploads prefixed as:** `uploads/{filename}` in database tracking

---

## Data Flow

### Complete Upload Workflow

```
1. User selects file(s) in browser
   ↓
2. Frontend validates extension + size
   ↓
3. Frontend POSTs to /api/ingest/upload
   ↓
4. Server saves file to ./uploads/ with unique name
   ↓
5. Server returns success
   ↓
6. Frontend POSTs to /api/ingest with action=ingest_new, forceReprocess=true
   ↓
7. Backend scans SOURCE_PATH + ./uploads/
   ↓
8. New files in ./uploads/ are processed
   ↓
9. V2 Pipeline: Extract → Normalize → Chunk → Embed → Store
   ↓
10. Backend streams progress via SSE
    ↓
11. Frontend updates progress bar + displays status
    ↓
12. Backend emits 'done' event
    ↓
13. Frontend refreshes document table
    ↓
14. Uploaded document appears in table with quality indicators
```

### Database State

After upload completes:

```sql
-- Document record created
SELECT title, source_path, extraction_status, text_quality_tier, chunk_count
FROM documents
WHERE source_path LIKE 'uploads/%'
ORDER BY created_at DESC;

-- Chunks created and embedded
SELECT chunk_index, is_boilerplate, retrieval_excluded, retrieval_downranked
FROM chunks
WHERE document_id = <uploaded_doc_id>
ORDER BY chunk_index;
```

---

## Quality Rules Applied

All existing V2 pipeline rules are applied to uploaded documents:

### Extraction Rules
- ✅ PDF native extraction vs OCR fallback
- ✅ Quality tier classification (good/partial/poor)
- ✅ Text quality scoring
- ✅ Quarantine detection (encrypted/corrupted)
- ✅ Needs review flagging

### Normalization Rules
- ✅ Boilerplate detection & removal
- ✅ Structural analysis (headings, tables, lists)
- ✅ Sanity validation (unusual structures)
- ✅ Fingerprint tracking (detect unchanged content)

### Chunking Rules
- ✅ Type-aware chunking (prose vs spreadsheet)
- ✅ Retrieval exclusion (boilerplate, metadata)
- ✅ Downranking (appendices, low-density content)
- ✅ Heading preservation for context

### Embedding Rules
- ✅ Batch embedding (50 chunks per batch)
- ✅ Only eligible chunks embedded
- ✅ Embedding status tracking
- ✅ Error handling & retry

### PDF Completeness Audit
- ✅ Trust scoring based on extraction method
- ✅ Risk assessment (high/medium/low)
- ✅ Completeness status (complete/partial/suspect)

---

## Testing

### Manual Test Cases

**Test 1: Simple PDF Upload**
- Prerequisite: Browser open on Ingest page
- Action: Upload a simple PDF (1-5 pages)
- Expected:
  - File appears in upload progress
  - Ingest starts automatically
  - Document appears in table within 30 seconds
  - Quality tier is "good" (native extraction)
  - Chunk count > 5

**Test 2: Unsupported Format**
- Prerequisite: Browser on Ingest page
- Action: Try to upload `.mp4` or `.svg` file
- Expected: Error message "Unsupported format"
- UI not blocked

**Test 3: Large File**
- Prerequisite: Browser on Ingest page
- Action: Upload 50MB+ PDF
- Expected:
  - Upload succeeds (within 100MB limit)
  - Processing takes 2-3 minutes
  - Progress bar updates continuously
  - Document eventually completes

**Test 4: Multiple Files**
- Prerequisite: Browser on Ingest page
- Action: Select 3 files at once
- Expected:
  - All files upload sequentially
  - Progress shown for each file
  - All 3 documents appear in table

**Test 5: Duplicate Upload**
- Prerequisite: Document already exists
- Action: Upload same PDF again (identical content)
- Expected:
  - File processes without error
  - Fingerprint match detected
  - Shows as "skipped" in ingestion stats
  - Table still shows one document (old version deactivated, new version not created due to hash match)

**Test 6: Modified Document**
- Prerequisite: Document already exists
- Action: Modify PDF and re-upload
- Expected:
  - Different content hash detected
  - Old version deactivated
  - New version becomes active
  - Chunk counts may differ
  - Quality tier may change

**Test 7: Retrieval Testing**
- Prerequisite: Document uploaded and completed
- Action: Go to Chat page, ask question about uploaded content
- Expected:
  - Question answered with citations
  - Citations point to uploaded document chunks
  - Semantic search works correctly
  - Quality tier indicators reflect in retrieval confidence

### Automated Tests

Covered by existing test suite:
- `src/lib/ingestion.ts` tests (extraction, normalization, chunking)
- `src/lib/embeddings.test.ts` (embedding pipeline)
- API integration tests (SSE progress handling)

New tests could cover:
- File upload endpoint validation
- Upload directory scanning
- Filename collision handling
- File size validation edge cases

---

## Troubleshooting

### Upload Hangs
- **Symptom:** Upload progress stuck at 50%
- **Cause:** Ingest already running (run lock conflict)
- **Fix:** Wait for previous ingest to complete (~5-10 minutes), then retry

### Upload Fails with "Unsupported Format"
- **Symptom:** Error on valid PDF
- **Cause:** File extension mismatch or corrupted file
- **Fix:** Check file has correct extension, try re-exporting

### Document Doesn't Appear After Upload
- **Symptom:** Upload succeeds but document missing from table
- **Cause:** Extraction failed (zero text extracted)
- **Fix:** Check Extraction Error column in table, verify file has readable content

### Quality Tier "Poor" After Upload
- **Symptom:** Document marked as poor quality
- **Cause:** Scanned PDF or heavy OCR required
- **Fix:** If possible, use higher-resolution scan or PDF with native text

### Search Doesn't Return Uploaded Document
- **Symptom:** Chat queries don't find content from uploaded file
- **Cause:** Document still embedding, or chunks marked as excluded
- **Fix:** Wait 1-2 minutes for embedding to complete, check Chunks column

---

## Performance Expectations

### Upload Speed
- File transfer: 1-10 MB/s (depends on network)
- Total upload time: <10 seconds for typical document

### Processing Speed (after upload)
- Small PDF (1-5 pages): 10-30 seconds
- Medium PDF (20-50 pages): 1-2 minutes  
- Large PDF (100+ pages): 3-5 minutes
- Scanned PDF with OCR: 30-60 seconds per page

### Storage Impact
- Small document (10 chunks): ~100KB
- Medium document (100 chunks): ~1MB  
- Large document (500+ chunks): ~5MB

---

## Security Considerations

### Current Implementation
- File extension whitelist enforced
- File size limit (100MB) prevents abuse
- Filename sanitization with UUID to prevent collisions
- Files saved to isolated directory (`./uploads/`)
- No authentication required (assumes local network)

### Recommendations for Production
- Add user authentication/authorization
- Add virus scanning on upload
- Implement rate limiting
- Add audit logging (who uploaded what, when)
- Encrypt files at rest if storing sensitive data
- Implement access controls on uploaded documents
- Add expiration policy for old uploads

---

## Future Enhancements

### Possible Improvements
1. **Batch upload progress** — Show all files in queue
2. **Upload queue** — Continue using UI while upload in progress
3. **Document versioning UI** — Show document history, compare versions
4. **Selective chunk filtering** — Allow user to exclude sections before embedding
5. **Metadata editing** — Let user add tags, description to documents
6. **Progress webhook** — POST updates to external system
7. **Scheduled ingestion** — Run ingest on cron schedule
8. **Import from URL** — Fetch documents from web
9. **Email import** — Accept documents via email attachment
10. **OCR settings** — Let user tune OCR parameters per document

---

## Related Documentation

- [Adding Documents (User Guide)](./adding-documents.md) — Operator instructions
- [Ingestion Pipeline Internals](./ingestion-pipeline-internals.md) — Developer reference
- [V2 Data Quality Rebuild Spec](../specs/2026-04-17-v2-data-quality-rebuild.md) — Technical specification
- [IDD Knowledge Chat Plan](../plans/2026-04-16-idd-knowledge-chat-plan.md) — Project history

---

## Implementation Checklist

- [x] Frontend upload UI with drag-and-drop
- [x] File validation (format, size)
- [x] Upload API endpoint (`/api/ingest/upload`)
- [x] Integration with ingestion pipeline
- [x] Scanning of uploads directory
- [x] Progress tracking via SSE
- [x] Error handling & user feedback
- [x] Operator documentation guide
- [x] Developer pipeline documentation
- [x] This implementation guide

**Status:** ✅ Complete and ready for use
