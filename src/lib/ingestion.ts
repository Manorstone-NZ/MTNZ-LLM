import { createHash } from 'crypto';
import { readdir, readFile, stat } from 'fs/promises';
import { join, relative, extname, basename, parse as parsePath } from 'path';

import sql from './db';
import type { ExtractedContent, PreparedChunk, DocumentRow, IngestRunResult } from './types';

import { extractPdf } from './extraction/pdf';
import { extractDocx } from './extraction/docx';
import { extractXlsx } from './extraction/xlsx';
import { extractTxt } from './extraction/txt';

import { chunkProse } from './chunking/prose';
import { chunkSpreadsheet } from './chunking/spreadsheet';

import { embedBatch } from './embeddings';

import {
  createDocument,
  findActiveBySourcePath,
  deactivateDocument,
  markSourceMissing,
  updateExtractionStatus,
  updateChunkCount,
  markCompleted,
} from './repositories/documents';

import { insertChunksWithEmbeddings, deleteChunksByDocumentId } from './repositories/chunks';

const SUPPORTED_EXTENSIONS = new Set(['.pdf', '.docx', '.xlsx', '.txt']);
const UNSUPPORTED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg', '.webp', '.mp3', '.mp4', '.wav', '.avi', '.mov']);

interface FileEntry {
  absolutePath: string;
  relativePath: string;
  filename: string;
  extension: string;
  folder: string;
}

export async function ingestDocuments(options: {
  sourcePath: string;
  forceReprocess?: boolean;
  singleFile?: string;
  onProgress?: (event: { file: string; status: string; processed: number; total: number }) => void;
}): Promise<IngestRunResult> {
  const { sourcePath, forceReprocess = false, singleFile, onProgress } = options;
  const concurrency = parseInt(process.env.INGEST_FILE_CONCURRENCY || '2');

  // --- Run locking ---
  const [existingRun] = await sql<{ id: string }[]>`
    SELECT id FROM ingest_runs WHERE status = 'running' LIMIT 1
  `;
  if (existingRun) {
    throw new Error(`Ingest already running (run_id: ${existingRun.id})`);
  }

  const [run] = await sql<{ id: string }[]>`
    INSERT INTO ingest_runs (status) VALUES ('running') RETURNING id
  `;
  const runId = run.id;

  const result: IngestRunResult = { run_id: runId, scanned: 0, processed: 0, failed: 0, skipped: 0 };

  try {
    // --- File scanning ---
    const allFiles = await scanFiles(sourcePath);
    const seenPaths = new Set<string>();

    let files: FileEntry[];
    if (singleFile) {
      files = allFiles.filter(f => f.relativePath === singleFile);
      if (files.length === 0) {
        throw new Error(`File not found: ${singleFile}`);
      }
    } else {
      files = allFiles;
    }

    // Separate supported from unsupported
    const supportedFiles: FileEntry[] = [];
    const skippedFiles: FileEntry[] = [];

    for (const file of files) {
      if (SUPPORTED_EXTENSIONS.has(file.extension)) {
        supportedFiles.push(file);
      } else {
        if (UNSUPPORTED_EXTENSIONS.has(file.extension)) {
          console.log(`  [skip] Unsupported type: ${file.relativePath}`);
        }
        skippedFiles.push(file);
      }
    }

    result.scanned = supportedFiles.length + skippedFiles.length;
    result.skipped = skippedFiles.length;

    // --- Process files with concurrency ---
    let processed = 0;
    let failed = 0;

    // Process in batches of `concurrency`
    for (let i = 0; i < supportedFiles.length; i += concurrency) {
      const batch = supportedFiles.slice(i, i + concurrency);
      const promises = batch.map(async (file) => {
        seenPaths.add(file.relativePath);
        try {
          const wasProcessed = await processFile(file, forceReprocess);
          if (wasProcessed) {
            processed++;
          } else {
            result.skipped++;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`  [FAIL] ${file.relativePath}: ${msg}`);
          failed++;
        }
        onProgress?.({
          file: file.relativePath,
          status: 'done',
          processed: processed + failed,
          total: supportedFiles.length,
        });
      });
      await Promise.all(promises);
    }

    result.processed = processed;
    result.failed = failed;

    // --- Source-missing detection (skip for single-file mode) ---
    if (!singleFile) {
      // Also add all supported files to seenPaths (they were already added above)
      // For unsupported files, we don't track them in documents table
      const activeDocRows = await sql<{ id: string; source_path: string }[]>`
        SELECT id, source_path FROM documents WHERE is_active = true
      `;
      for (const doc of activeDocRows) {
        if (!seenPaths.has(doc.source_path)) {
          console.log(`  [missing] ${doc.source_path}`);
          await markSourceMissing(doc.id);
        }
      }
    }

    // --- Finalize ---
    await sql`
      UPDATE ingest_runs
      SET status = 'completed',
          finished_at = now(),
          scanned_count = ${result.scanned},
          processed_count = ${result.processed},
          failed_count = ${result.failed},
          skipped_count = ${result.skipped}
      WHERE id = ${runId}
    `;
  } catch (err) {
    await sql`
      UPDATE ingest_runs
      SET status = 'failed',
          finished_at = now(),
          scanned_count = ${result.scanned},
          processed_count = ${result.processed},
          failed_count = ${result.failed},
          skipped_count = ${result.skipped},
          notes = ${err instanceof Error ? err.message : String(err)}
      WHERE id = ${runId}
    `;
    throw err;
  }

  return result;
}

/**
 * Recursively scan sourcePath for files, applying skip rules.
 */
async function scanFiles(sourcePath: string): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];

  async function walk(dir: string) {
    const items = await readdir(dir, { withFileTypes: true });
    for (const item of items) {
      // Skip dotfiles and directories
      if (item.name.startsWith('.')) continue;
      // Skip .DS_Store
      if (item.name === '.DS_Store') continue;
      // Skip temp Office files
      if (item.name.startsWith('~$')) continue;

      const fullPath = join(dir, item.name);

      if (item.isDirectory()) {
        await walk(fullPath);
      } else if (item.isFile()) {
        const relPath = relative(sourcePath, fullPath);
        const ext = extname(item.name).toLowerCase();
        const parts = relPath.split('/');
        const folder = parts.length > 1 ? parts[0] : 'root';

        entries.push({
          absolutePath: fullPath,
          relativePath: relPath,
          filename: item.name,
          extension: ext,
          folder,
        });
      }
    }
  }

  await walk(sourcePath);
  return entries;
}

/**
 * Process a single file through the full pipeline.
 * Returns true if the file was processed, false if skipped (unchanged).
 */
async function processFile(file: FileEntry, forceReprocess: boolean): Promise<boolean> {
  const buffer = await readFile(file.absolutePath);
  const hash = createHash('sha256').update(buffer).digest('hex');

  // Check for existing active document
  const existingDoc = await findActiveBySourcePath(file.relativePath);

  if (!forceReprocess && existingDoc && existingDoc.version_hash === hash) {
    // Unchanged — update last_seen_at and skip
    await sql`
      UPDATE documents SET last_seen_at = now() WHERE id = ${existingDoc.id}
    `;
    console.log(`  [unchanged] ${file.relativePath}`);
    return false;
  }

  console.log(`  [processing] ${file.relativePath}`);

  const docTitle = parsePath(file.filename).name;
  const sourceType = file.extension.slice(1); // remove dot

  // Deactivate existing doc first to avoid unique constraint on active source_path.
  // If the new ingest fails, the old version is already deactivated — but a failed
  // new doc is still recorded, so the data loss is visible and recoverable.
  if (existingDoc) {
    await deactivateDocument(existingDoc.id);
    console.log(`  [deactivated] old doc ${existingDoc.id} for ${file.relativePath}`);
  }

  // Step 4a: Create new document row
  const newDoc = await createDocument({
    title: docTitle,
    filename: file.filename,
    source_path: file.relativePath,
    folder: file.folder,
    source_type: sourceType,
    version_hash: hash,
  });

  try {
    // Step 4b: Extract
    await updateExtractionStatus(newDoc.id, 'extracting');
    let extracted: ExtractedContent;

    switch (file.extension) {
      case '.pdf':
        extracted = await extractPdf(buffer, file.filename);
        break;
      case '.docx':
        extracted = await extractDocx(buffer, file.filename);
        break;
      case '.xlsx':
        extracted = await extractXlsx(buffer, file.filename);
        break;
      case '.txt':
        extracted = await extractTxt(buffer.toString('utf-8'), file.filename);
        break;
      default:
        throw new Error(`Unsupported file type: ${file.extension}`);
    }

    // Step 4c: Check extraction result
    if (!extracted.sections || extracted.sections.length === 0) {
      await updateExtractionStatus(newDoc.id, 'failed', 'No content extracted');
      // If replacing, don't deactivate old doc since new one failed
      return true; // still counts as processed (failed)
    }

    // Update OCR metadata if applicable
    if (extracted.ocr_used) {
      await sql`
        UPDATE documents SET ocr_used = ${extracted.ocr_used}, ocr_confidence = ${extracted.ocr_confidence ?? null} WHERE id = ${newDoc.id}
      `;
    }

    // Step 4d: Chunk
    await updateExtractionStatus(newDoc.id, 'chunking');
    let chunks: PreparedChunk[];

    if (file.extension === '.xlsx') {
      chunks = chunkSpreadsheet(extracted.sections, docTitle);
    } else {
      chunks = chunkProse(extracted.sections, docTitle);
    }

    // Deduplicate chunks by chunk_hash (some extractors produce identical chunks)
    const seenHashes = new Set<string>();
    chunks = chunks.filter(c => {
      if (seenHashes.has(c.chunk_hash)) return false;
      seenHashes.add(c.chunk_hash);
      return true;
    });
    // Re-index after dedup
    chunks.forEach((c, i) => { c.chunk_index = i; });

    // Step 4e: Check chunks
    if (chunks.length === 0) {
      await updateExtractionStatus(newDoc.id, 'failed', 'Zero chunks produced');
      return true;
    }

    // Step 4f: Embed
    await updateExtractionStatus(newDoc.id, 'embedding');
    const embeddings = await embedBatch(chunks.map(c => c.content));

    // Step 4g: Store
    await updateExtractionStatus(newDoc.id, 'storing');
    await insertChunksWithEmbeddings(newDoc.id, chunks, embeddings);

    // Step 4h: Update chunk count
    await updateChunkCount(newDoc.id, chunks.length);

    // Step 4i: Mark completed
    await markCompleted(newDoc.id);

    console.log(`  [done] ${file.relativePath} → ${chunks.length} chunks`);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await updateExtractionStatus(newDoc.id, 'failed', msg);
    throw err;
  }
}
