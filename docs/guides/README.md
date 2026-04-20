# IDD Knowledge Chat — Guides & Documentation

This directory contains comprehensive guides for using and maintaining the IDD Knowledge Chat system.

---

## For Operators & End Users

### [Adding Documents to the Knowledge Base](./adding-documents.md)
**Read this if you want to:**
- Upload new documents via the browser UI
- Understand the document processing pipeline
- Interpret quality indicators
- Troubleshoot ingestion issues

**Time to read:** ~5 minutes  
**Prerequisites:** None, designed for non-technical users

**Key topics:**
- Quick start (3-step process)
- What happens when you upload
- Quality indicators (good/partial/poor)
- Chunk counts & exclusions
- Best practices per file type
- FAQ

---

## For Developers & System Administrators

### [Ingestion Pipeline Internals](./ingestion-pipeline-internals.md)
**Read this if you want to:**
- Understand the V2 three-stage ingestion pipeline
- Learn all 14 quality & processing rules
- Modify ingestion behavior
- Add new extraction methods
- Troubleshoot ingestion failures
- Monitor system health

**Time to read:** ~30 minutes  
**Prerequisites:** Familiarity with Node.js, TypeScript, PostgreSQL

**Key topics:**
- Architecture overview
- Extraction, normalization, and chunking stages
- Quality rules and thresholds
- PDF completeness audit
- Embedding strategy
- Configuration & environment variables
- Extension points & customization

### [Document Upload Feature Implementation](./document-upload-implementation.md)
**Read this if you want to:**
- Understand how the file upload feature works
- See the complete data flow
- Set up or configure upload handling
- Run test cases
- Plan future enhancements

**Time to read:** ~15 minutes  
**Prerequisites:** Understanding of Next.js, React, API routes

**Key topics:**
- Feature architecture
- Frontend upload UI components
- Backend file upload API
- Ingestion pipeline integration
- Configuration options
- Complete test cases
- Troubleshooting guide
- Performance expectations

---

## Quick Navigation

### I want to...

| Task | Read This |
|------|-----------|
| Upload a PDF to the knowledge base | [Adding Documents](./adding-documents.md) — Quick Start |
| Understand why my document shows "poor" quality | [Adding Documents](./adding-documents.md) — Quality Indicators |
| Customize chunk size or quality thresholds | [Ingestion Internals](./ingestion-pipeline-internals.md) — Configuration |
| Add a new extraction method (e.g., new file format) | [Ingestion Internals](./ingestion-pipeline-internals.md) — Extension Points |
| Debug an ingestion failure | [Adding Documents](./adding-documents.md) — Troubleshooting |
| Understand the file upload API | [Upload Implementation](./document-upload-implementation.md) — File Upload API |
| Run test cases for the upload feature | [Upload Implementation](./document-upload-implementation.md) — Testing |
| Performance tune ingestion | [Ingestion Internals](./ingestion-pipeline-internals.md) — Performance Characteristics |

---

## Document Processing Pipeline (Overview)

Every document uploaded goes through this pipeline:

```
UPLOAD
  ↓
EXTRACT ← PDF.js native extraction, OCR fallback, DOCX/XLSX parsing
  ├─ Quality scoring & tier classification
  ├─ Quarantine detection (encrypted, corrupted, unreadable)
  └─ Extraction method tracking
  ↓
NORMALIZE ← Text cleaning, structure analysis, boilerplate detection
  ├─ Heading detection & hierarchical structure
  ├─ Sanity validation (flag unusual structures)
  └─ Fingerprint generation (detect unchanged content)
  ↓
CHUNK ← Semantic text chunking, type-aware processing
  ├─ Prose: 500-1000 word chunks with paragraph boundaries
  ├─ Spreadsheet: Row/column structure preserved
  ├─ Boilerplate marked for potential exclusion
  └─ Downranking applied (e.g., appendices)
  ↓
EMBED ← Vector generation for semantic search
  ├─ Only eligible chunks embedded (excluded chunks skipped)
  ├─ 1536-dimensional embeddings
  └─ Batch processing for efficiency
  ↓
STORE ← Database insertion, indexing, audit trail
  ├─ Document metadata stored with versions tracked
  ├─ Chunks indexed for retrieval
  ├─ PDF completeness trust score calculated
  └─ Ingestion run logged for audit

READY ← Document appears in chat retrieval & answering
```

**Total time:** 10 seconds to 3 minutes per document (depends on size, format, complexity)

---

## Key Concepts

### Quality Tier
- **good** — Native extraction successful, high-confidence text
- **partial** — Mixed extraction methods, some OCR
- **poor** — Heavy OCR dependency, low-confidence text

### Extraction Method
- **native_pdfjs** — PDF text extracted directly (fast, high confidence)
- **ocr** — Optical Character Recognition applied (slower, for scanned PDFs)
- **native_docx** — Word document natively parsed
- **native_xlsx** — Excel file structurally preserved
- **native_txt** — Text file parsed
- **ocr_fallback** — OCR used because native extraction failed

### Chunk Separation
- **embedded** — Chunks that get vector embeddings (searchable)
- **excluded** — Boilerplate/metadata (not embedded, saves space)
- **downranked** — Lower retrieval ranking (e.g., appendices)

### Document Status
- ✅ **completed** — Fully processed, ready for Q&A
- 🔄 **extracting** — Currently extracting text
- 🔄 **normalising** — Currently cleaning and chunking
- 🔄 **embedding** — Currently generating vectors
- ⚠️ **failed** — Processing error
- 🟡 **needs_review** — Processed but flagged for inspection

---

## Related Resources

### Project Specifications
- [IDD Knowledge Chat Design Spec](../specs/2026-04-16-idd-knowledge-chat-design.md)
- [V2 Data Quality Rebuild Spec](../specs/2026-04-17-v2-data-quality-rebuild.md)
- [Solution Architecture](../specs/2026-04-19-solution-architecture.md)

### Implementation Plans
- [IDD Knowledge Chat Plan](../plans/2026-04-16-idd-knowledge-chat-plan.md)
- [V2 Data Quality Rebuild Plan](../plans/2026-04-17-v2-data-quality-rebuild-plan.md)

### User Manual
- [IDD Knowledge Chat User Manual](../user-manual.md) — General system usage

### Implementation Reports
- [Implementation Complete Report](../reports/2026-04-21-implementation-complete.md)
- [Live Validation Reports](../reports/2026-04-19-live-validation/)
- [Continuous Re-OCR Reports](../reports/2026-04-20-continuous-reocr/)

---

## System Health Monitoring

The **Ingest** page displays real-time health metrics:

- **Active Docs** — Currently active documents in system
- **Quality Distribution** — Good/Partial/Poor breakdown
- **OCR Usage** — Percentage of docs using OCR
- **Avg Chunks/Doc** → Average document size
- **Last Ingest Run** → When ingestion last completed

---

## Support & Troubleshooting

### Common Issues

**Upload fails with "Unsupported Format"**
→ Check file extension. Supported: PDF, DOCX, XLSX, TXT, PNG, JPG, GIF, WebP, TIFF

**Document shows "poor" quality**
→ Check Extraction Method. If "ocr", text came from OCR with lower confidence. Still usable.

**Ingest hangs or times out**
→ Previous ingest still running. Wait 5-10 minutes or restart application.

**Search doesn't find content from uploaded document**
→ Check document status is "completed" and chunks are "embedded" (not excluded).

### Getting Help

1. Check [Adding Documents](./adding-documents.md) FAQ section
2. Review [Ingestion Internals](./ingestion-pipeline-internals.md) Troubleshooting section
3. Check application logs for detailed error messages
4. Review database `ingest_runs` table for ingestion history

---

**Last Updated:** April 2026  
**Version:** 2.0 (V2 Data Quality Pipeline)
