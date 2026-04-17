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
import { normalise } from './normalise';
import { computeBoilerplateHash, updateFingerprint } from './normalise/boilerplate';

import {
  createDocument,
  findActiveBySourcePath,
  deactivateDocument,
  markSourceMissing,
  updateExtractionStatus,
  updateChunkCount,
  markCompleted,
  updateDocumentNormStats,
  setQuarantined,
} from './repositories/documents';

import { insertChunksV2, deleteChunksByDocumentId } from './repositories/chunks';

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
  rebuild?: boolean;
  onProgress?: (event: { file: string; status: string; processed: number; total: number }) => void;
}): Promise<IngestRunResult> {
  const { sourcePath, forceReprocess = false, singleFile, rebuild = false, onProgress } = options;
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

  const result: IngestRunResult = {
    run_id: runId, scanned: 0, processed: 0, failed: 0, skipped: 0,
    ocr_routed: 0, quarantined: 0,
    excluded_chunks: 0, downranked_chunks: 0,
    embedded_chunks: 0, skipped_embeddings: 0,
  };

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

    if (rebuild) {
      // ============================================================
      // TWO-PASS REBUILD MODE
      // ============================================================
      console.log('  [rebuild] Pass 1: Extracting and fingerprinting all documents...');

      // Pass 1: Extract + classify + fingerprint (no normalise/chunk/embed/store)
      const extractedDocs: { file: FileEntry; buffer: Buffer; hash: string; extracted: ExtractedContent; docTitle: string }[] = [];

      for (let i = 0; i < supportedFiles.length; i += concurrency) {
        const batch = supportedFiles.slice(i, i + concurrency);
        const promises = batch.map(async (file) => {
          seenPaths.add(file.relativePath);
          try {
            const buffer = await readFile(file.absolutePath);
            const hash = createHash('sha256').update(buffer).digest('hex');

            const existingDoc = await findActiveBySourcePath(file.relativePath);
            if (!forceReprocess && existingDoc && existingDoc.version_hash === hash) {
              await sql`UPDATE documents SET last_seen_at = now() WHERE id = ${existingDoc.id}`;
              console.log(`  [unchanged] ${file.relativePath}`);
              result.skipped!++;
              return;
            }

            console.log(`  [pass1:extract] ${file.relativePath}`);
            const docTitle = parsePath(file.filename).name;
            const extracted = await extractFile(file, buffer);

            if (!extracted.sections || extracted.sections.length === 0) {
              console.log(`  [pass1:empty] ${file.relativePath}`);
              return;
            }

            // Fingerprint all sections (collect corpus counts for pass 2)
            for (const section of extracted.sections) {
              const hash = computeBoilerplateHash(section.content);
              await updateFingerprint(hash, section.content);
            }

            extractedDocs.push({ file, buffer, hash, extracted, docTitle });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`  [pass1:FAIL] ${file.relativePath}: ${msg}`);
            result.failed++;
          }
        });
        await Promise.all(promises);
      }

      console.log(`  [rebuild] Pass 2: Normalising, chunking, embedding ${extractedDocs.length} documents...`);

      // Pass 2: Full pipeline with stable fingerprint counts
      for (let i = 0; i < extractedDocs.length; i += concurrency) {
        const batch = extractedDocs.slice(i, i + concurrency);
        const promises = batch.map(async ({ file, buffer, hash, extracted, docTitle }) => {
          try {
            const wasProcessed = await processFileV2(file, forceReprocess, 'rebuild', {
              preExtracted: extracted,
              preComputedHash: hash,
            });
            if (wasProcessed) {
              result.processed++;
              // Accumulate v2 metrics from the processed file
              // (metrics are aggregated at the end from DB)
            } else {
              result.skipped!++;
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`  [pass2:FAIL] ${file.relativePath}: ${msg}`);
            result.failed++;
          }
          onProgress?.({
            file: file.relativePath,
            status: 'done',
            processed: result.processed + result.failed,
            total: extractedDocs.length,
          });
        });
        await Promise.all(promises);
      }
    } else {
      // ============================================================
      // SINGLE-PASS INCREMENTAL MODE (default)
      // ============================================================
      let processed = 0;
      let failed = 0;

      for (let i = 0; i < supportedFiles.length; i += concurrency) {
        const batch = supportedFiles.slice(i, i + concurrency);
        const promises = batch.map(async (file) => {
          seenPaths.add(file.relativePath);
          try {
            const wasProcessed = await processFileV2(file, forceReprocess, 'incremental');
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
    }

    // --- Source-missing detection (skip for single-file mode) ---
    if (!singleFile) {
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

    // --- Aggregate v2 metrics from DB ---
    const [v2Metrics] = await sql<{
      quarantined_count: string;
      excluded_chunk_count: string;
      downranked_chunk_count: string;
      embedded_chunk_count: string;
      skipped_embedding_count: string;
    }[]>`
      SELECT
        count(DISTINCT d.id) FILTER (WHERE d.quarantined = true) AS quarantined_count,
        coalesce(sum(d.excluded_chunk_count) FILTER (WHERE d.is_active = true), 0) AS excluded_chunk_count,
        coalesce(sum(d.downranked_chunk_count) FILTER (WHERE d.is_active = true), 0) AS downranked_chunk_count,
        count(c.id) FILTER (WHERE c.embedding_status = 'embedded') AS embedded_chunk_count,
        count(c.id) FILTER (WHERE c.embedding_status = 'skipped_excluded') AS skipped_embedding_count
      FROM documents d
      LEFT JOIN chunks c ON c.document_id = d.id
      WHERE d.is_active = true AND d.pipeline_version = 'v2'
    `;
    result.quarantined = Number(v2Metrics?.quarantined_count ?? 0);
    result.excluded_chunks = Number(v2Metrics?.excluded_chunk_count ?? 0);
    result.downranked_chunks = Number(v2Metrics?.downranked_chunk_count ?? 0);
    result.embedded_chunks = Number(v2Metrics?.embedded_chunk_count ?? 0);
    result.skipped_embeddings = Number(v2Metrics?.skipped_embedding_count ?? 0);

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
 * Extract file content based on extension.
 */
async function extractFile(file: FileEntry, buffer: Buffer): Promise<ExtractedContent> {
  switch (file.extension) {
    case '.pdf':
      return extractPdf(buffer, file.filename);
    case '.docx':
      return extractDocx(buffer, file.filename);
    case '.xlsx':
      return extractXlsx(buffer, file.filename);
    case '.txt':
      return extractTxt(buffer.toString('utf-8'), file.filename);
    default:
      throw new Error(`Unsupported file type: ${file.extension}`);
  }
}

/**
 * V2 three-stage pipeline: extract → normalise → compose → embed (eligible only) → store.
 * Returns true if the file was processed, false if skipped (unchanged).
 */
async function processFileV2(
  file: FileEntry,
  forceReprocess: boolean,
  mode: 'rebuild' | 'incremental',
  preComputed?: {
    preExtracted?: ExtractedContent;
    preComputedHash?: string;
  },
): Promise<boolean> {
  const buffer = await readFile(file.absolutePath);
  const hash = preComputed?.preComputedHash ?? createHash('sha256').update(buffer).digest('hex');

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

  // Deactivate existing doc first
  if (existingDoc) {
    await deactivateDocument(existingDoc.id);
    console.log(`  [deactivated] old doc ${existingDoc.id} for ${file.relativePath}`);
  }

  // Step 1: Create new document row with v2 fields
  const newDoc = await createDocument({
    title: docTitle,
    filename: file.filename,
    source_path: file.relativePath,
    folder: file.folder,
    source_type: sourceType,
    version_hash: hash,
    pipeline_version: 'v2',
  });

  try {
    // Step 2: Extract
    await updateExtractionStatus(newDoc.id, 'extracting');
    const extracted = preComputed?.preExtracted ?? await extractFile(file, buffer);

    // Step 2a: Check extraction result
    if (!extracted.sections || extracted.sections.length === 0) {
      await updateExtractionStatus(newDoc.id, 'failed', 'No content extracted');
      return true;
    }

    // Step 2b: Store extraction metadata on document
    const extractionMethod = extracted.ocr_used ? 'ocr' : 'native_' + sourceType;
    const textQualityScore = (extracted.metadata?.text_quality_score as number) ?? null;
    const textQualityTier = (extracted.metadata?.text_quality_tier as 'good' | 'partial' | 'poor') ?? null;
    const qualityScoreSource = extracted.ocr_used
      ? 'ocr_output' as const
      : 'native_extraction' as const;

    await sql`
      UPDATE documents
      SET ocr_used = ${extracted.ocr_used ?? false},
          ocr_confidence = ${extracted.ocr_confidence ?? null},
          extraction_method = ${extractionMethod},
          text_quality_score = ${textQualityScore},
          text_quality_tier = ${textQualityTier},
          quality_score_source = ${qualityScoreSource}
      WHERE id = ${newDoc.id}
    `;

    if (extracted.ocr_used) {
      // Track OCR routing
      console.log(`  [ocr] ${file.relativePath}`);
    }

    // Step 2c: Check for quarantine (from extraction metadata)
    const shouldQuarantine = (extracted.metadata?.quarantine as boolean) ?? false;
    if (shouldQuarantine) {
      await setQuarantined(newDoc.id);
      console.log(`  [quarantined] ${file.relativePath}`);
    }

    // Step 3: Normalise
    await updateExtractionStatus(newDoc.id, 'normalising');
    const normResult = await normalise(extracted.sections, docTitle, mode);

    // Step 3a: Handle sanity warning
    if (normResult.sanity_warning) {
      await sql`UPDATE documents SET needs_review = true WHERE id = ${newDoc.id}`;
      console.log(`  [needs_review] ${file.relativePath} — sanity warning from normalisation`);
    }

    // Step 4: Chunk (compose)
    await updateExtractionStatus(newDoc.id, 'chunking');
    let chunks: PreparedChunk[];

    if (file.extension === '.xlsx') {
      chunks = chunkSpreadsheet(normResult.sections, docTitle);
    } else {
      chunks = chunkProse(normResult.sections, docTitle);
    }

    // Deduplicate chunks by chunk_hash
    const seenHashes = new Set<string>();
    chunks = chunks.filter(c => {
      if (seenHashes.has(c.chunk_hash)) return false;
      seenHashes.add(c.chunk_hash);
      return true;
    });
    // Re-index after dedup
    chunks.forEach((c, i) => { c.chunk_index = i; });

    // Step 4a: If quarantined, mark ALL chunks as excluded
    if (shouldQuarantine) {
      for (const chunk of chunks) {
        chunk.retrieval_excluded = true;
        chunk.embedding_status = 'skipped_excluded';
      }
    }

    // Step 5: Separate eligible vs excluded chunks
    const eligibleChunks = chunks.filter(c => !c.retrieval_excluded);
    const excludedChunks = chunks.filter(c => c.retrieval_excluded);

    // Set embedding_status on each
    for (const chunk of eligibleChunks) {
      chunk.embedding_status = 'embedded';
    }
    for (const chunk of excludedChunks) {
      chunk.embedding_status = 'skipped_excluded';
    }

    // Step 5a: Check total chunks
    if (chunks.length === 0) {
      await updateExtractionStatus(newDoc.id, 'failed', 'Zero chunks produced');
      return true;
    }

    // Step 6: Embed only eligible chunks
    let embeddings: number[][] = [];
    if (eligibleChunks.length > 0) {
      await updateExtractionStatus(newDoc.id, 'embedding');
      embeddings = await embedBatch(eligibleChunks.map(c => c.content));
    }

    // Step 7: Store all chunks
    await updateExtractionStatus(newDoc.id, 'storing');

    // Enforce embedding invariant: retrieval_excluded=true must NEVER have embedding_status='embedded'
    for (const chunk of excludedChunks) {
      if (chunk.embedding_status === 'embedded') {
        throw new Error(`Embedding invariant violation: excluded chunk ${chunk.chunk_index} has embedding_status='embedded'`);
      }
    }

    await insertChunksV2(newDoc.id, eligibleChunks, embeddings, excludedChunks);

    // Step 8: Update document stats
    const totalChunks = chunks.length;
    const excludedCount = excludedChunks.length;
    const boilerplateCount = chunks.filter(c => c.is_boilerplate).length;
    const downrankedCount = chunks.filter(c => c.retrieval_downranked).length;

    await updateChunkCount(newDoc.id, totalChunks);
    await updateDocumentNormStats(newDoc.id, {
      excluded_chunk_count: excludedCount,
      boilerplate_chunk_count: boilerplateCount,
      downranked_chunk_count: downrankedCount,
    });

    // Step 9: Mark completed — only after chunks stored and embedding states finalised
    await markCompleted(newDoc.id);

    console.log(
      `  [done] ${file.relativePath} → ${totalChunks} chunks ` +
      `(${eligibleChunks.length} embedded, ${excludedCount} excluded, ${downrankedCount} downranked)`
    );
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await updateExtractionStatus(newDoc.id, 'failed', msg);
    throw err;
  }
}
