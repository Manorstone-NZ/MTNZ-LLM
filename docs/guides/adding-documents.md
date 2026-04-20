# Adding Documents to the IDD Knowledge Chat

**Audience:** Operators and analysts using the IDD Knowledge Chat system

**Time to read:** ~5 minutes | **Time to process a document:** 10 seconds to 2 minutes (depends on file size and content)

---

## Quick Start

1. Open the **Ingest** page in your browser (`http://localhost:3000/ingest`)
2. Click the **Upload Documents** button
3. Select one or more files (PDF, Word, Excel, text, or images)
4. Watch the progress indicator as your documents are processed
5. New documents appear automatically in the table below

That's it! The system handles everything else.

---

## What Happens When You Upload

### Phase 1: Upload & Validation (seconds)
- Your files are uploaded to the server
- Checked for format, size, and duplicates
- If a document with the same content already exists, it's skipped

### Phase 2: Extraction (10-30 seconds per file)
- **PDFs** → Text extracted using PDF.js (native extraction) OR Tesseract OCR (if native fails)
- **Word documents** → Content extracted with structure preserved
- **Excel files** → Cells converted to structured text
- **Images** → OCR applied to extract text
- **Text files** → Parsed as-is
- Quality score calculated automatically

### Phase 3: Normalization & Chunking (5-15 seconds per file)
- Text cleaned and standardized
- Broken into searchable chunks (typical: 500-1000 words each)
- Special content identified:
  - **Headings** → Tracked for navigation
  - **Tables** → Preserved as formatted chunks
  - **Boilerplate** → Footer/header text separated
  - **Appendices** → Marked for potential lower ranking
  - **Lists** → Grouped logically

### Phase 4: Embedding & Storage (5-10 seconds per file)
- Important chunks are converted to vector embeddings (semantic search)
- Excluded chunks (like boilerplate) skip embedding to save space
- Data stored in database with quality metadata
- Document marked as ready for Q&A

---

## Quality Indicators

After upload completes, check the **Ingest** page table for quality signals:

### Status Column
- ✅ **completed** — Document fully processed and searchable
- 🔄 **extracting** — Currently extracting text
- 🔄 **normalising** — Currently cleaning and chunking
- 🔄 **embedding** — Currently generating vector embeddings
- ⚠️ **failed** — Processing error; see error message
- 🟡 **needs_review** — Document processed but flagged for quality review

### Quality Tier
- 🟢 **good** — Native extraction successful, high-confidence text
- 🟡 **partial** — Mixed extraction methods or some OCR fallback
- 🔴 **poor** — Heavy OCR dependency, low-confidence text

### Text Quality Score
- Range: 0 to 1
- **0.8+** → High confidence
- **0.5-0.8** → Medium confidence (mixed extraction)
- **<0.5** → Low confidence (heavy OCR)

### Extraction Method
- **native_pdfjs** — PDF text extracted directly
- **native_docx** — Word content extracted natively
- **native_xlsx** → Excel cells converted
- **native_txt** → Text file parsed
- **ocr** — Optical Character Recognition applied
- **ocr_fallback** — OCR used because native extraction failed

---

## Understanding Chunk Counts

The **Chunks** column shows how the document was split:

**Example:** `544 chunks (508 embedded, 36 excluded, 0 downranked)`

- **embedded (508)** → Searchable via semantic search
- **excluded (36)** → Boilerplate/low-value content (footers, headers)
- **downranked (0)** → Lower search ranking (appendices, less relevant sections)

---

## Troubleshooting

### Upload Fails with "Unsupported Format"
**Supported formats:**
- PDF (`.pdf`)
- Word (`.docx`)
- Excel (`.xlsx`)
- Text (`.txt`)
- Images (`.png`, `.jpg`, `.jpeg`, `.gif`, `.bmp`, `.webp`, `.tif`)

**Not supported:** `.svg`, `.mp3`, `.mp4`, audio/video files

### Upload Hangs or Takes Too Long
- **PDF large (>50MB)?** → May take 2-3 minutes
- **Many images?** → OCR can be slow; 1 minute per image typical
- **Browser tab closed?** → Upload may cancel; try again

### Document Shows "needs_review"
- Document was processed but flagged as unusual
- **Common causes:**
  - Heavy OCR usage (low-confidence text)
  - Unusual structure detected (table-heavy, minimal prose)
  - Mixed extraction methods
- **Action:** Review the document in context or check the `Extraction Error` column for details

### Quality Score is Low (< 0.5)
- Document likely relied on OCR
- **Why?** PDF was scanned image or had complex layout
- **Is it okay to use?** Yes, but answers may be less precise
- **Better extraction possible?** Re-upload a higher-quality PDF if available

---

## Best Practices

### For PDFs
- Use searchable PDFs when possible (native extraction works best)
- If PDF is scanned/image-based, OCR will be used automatically
- Quality → Partial tier expected for mixed documents
- Test question answering to ensure content is captured

### For Images & Scans
- Ensure image is clear and legible
- 200+ DPI recommended for OCR accuracy
- Single images converted to ~3-10 chunks depending on complexity
- Plan for ~1 minute processing time per image

### For Spreadsheets & Tables
- Excel files processed as structured data
- Column headers preserved as context
- Tables → Readable chunks with relationships maintained
- Typical: 1-5 chunks per spreadsheet

### For Word Documents
- Formatting and structure preserved
- Headings, lists, tables handled correctly
- Typical: 1-2 chunks per page

---

## Understanding the Health Dashboard

The top of the **Ingest** page shows system health:

- **Active Docs** → Total documents currently in the system
- **Active (Completed)** → Documents fully processed
- **Active (Pending)** → Documents still extracting/embedding
- **Active (Failed)** → Documents with errors
- **Active Chunks** → Total searchable chunks across all documents
- **OCR Used** → Percentage of documents using OCR
- **Quality Distribution** → Good/Partial/Poor breakdown
- **Avg Chunks/Doc** → Average content size

---

## FAQ

**Q: Can I upload the same document twice?**
A: The system tracks document content via SHA-256 hash. If you upload an identical file, it's recognized as unchanged and skipped. If you modify and re-upload, it's processed as a new version and replaces the old one.

**Q: Can I upload multiple documents at once?**
A: Yes! Select multiple files in the file picker. They'll upload and process sequentially.

**Q: How long does processing take?**
A: Typically 30-60 seconds per document (extraction + normalization + embedding). Large PDFs or image-heavy documents may take 2-3 minutes.

**Q: Can I search for documents immediately after uploading?**
A: Wait for the status to change to **completed** before asking questions about that document. During processing (extracting, normalising, embedding), it won't be in the search index yet.

**Q: What if extraction fails?**
A: Check the **Extraction Error** column for the error message. Common issues:
- File corrupted → Try re-downloading/re-exporting
- Format mismatch → `.docx` file saved as `.pdf` → Rename and re-upload
- Unsupported encoding → Try converting to UTF-8 text

**Q: Can I delete documents?**
A: Currently, documents are marked as inactive rather than deleted (audit trail preserved). Contact a system administrator to permanently remove documents.

**Q: Why does embedding take so long?**
A: Vector embeddings are computed for each chunk (~100 chunks typical per doc). Embedding is compute-intensive but runs in batches for efficiency.

---

## Next Steps

After uploading documents:

1. **Test retrieval** → Go to Chat page and ask questions
2. **Monitor quality** → Check Ingest page for extraction quality indicators
3. **Review flagged docs** → If `needs_review` flag set, investigate further

For more technical details about the ingestion pipeline, see [Ingestion Pipeline Internals](./ingestion-pipeline-internals.md).
