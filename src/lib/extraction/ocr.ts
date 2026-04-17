import { execFileSync } from 'child_process';
import { writeFileSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ExtractedContent, ExtractedSection } from '../types';

// ---------------------------------------------------------------------------
// Native Tesseract detection
// ---------------------------------------------------------------------------

let _nativeTesseractPath: string | null | undefined;

function findNativeTesseract(): string | null {
  if (_nativeTesseractPath !== undefined) return _nativeTesseractPath;
  try {
    const path = execFileSync('which', ['tesseract'], { encoding: 'utf-8' }).trim();
    _nativeTesseractPath = path || null;
  } catch {
    _nativeTesseractPath = null;
  }
  return _nativeTesseractPath;
}

// ---------------------------------------------------------------------------
// PDF page to image conversion
// ---------------------------------------------------------------------------

/**
 * Convert a PDF buffer to per-page PNG image buffers.
 *
 * Strategy: use pdftoppm (poppler-utils) if available, otherwise attempt
 * pdfjs-dist with canvas. pdftoppm is the most reliable path on systems
 * that have poppler-utils installed.
 */
async function pdfToImages(
  buffer: Buffer,
): Promise<{ images: Buffer[]; pageCount: number }> {
  // Try pdftoppm (poppler-utils) first — most reliable for Node
  const pdftoppm = findPdftoppm();
  if (pdftoppm) {
    return pdfToImagesViaPdftoppm(buffer, pdftoppm);
  }

  // Fallback: try pdfjs-dist + canvas (may not work in all Node versions)
  try {
    return await pdfToImagesViaPdfjs(buffer);
  } catch {
    // Last resort: return empty — OCR will report no pages processed
    return { images: [], pageCount: 0 };
  }
}

function findPdftoppm(): string | null {
  try {
    const path = execFileSync('which', ['pdftoppm'], { encoding: 'utf-8' }).trim();
    return path || null;
  } catch {
    return null;
  }
}

function makeTempDir(): string {
  const workDir = join(tmpdir(), `ocr-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(workDir, { recursive: true });
  return workDir;
}

function cleanupTempDir(workDir: string): void {
  try {
    execFileSync('rm', ['-rf', workDir], { timeout: 5_000 });
  } catch {
    // Best-effort cleanup
  }
}

function pdfToImagesViaPdftoppm(
  buffer: Buffer,
  pdftoppmPath: string,
): { images: Buffer[]; pageCount: number } {
  const workDir = makeTempDir();
  const pdfPath = join(workDir, 'input.pdf');
  const outputPrefix = join(workDir, 'page');

  try {
    writeFileSync(pdfPath, buffer);

    // Convert to PNG at 300 DPI for good OCR quality
    execFileSync(
      pdftoppmPath,
      ['-png', '-r', '300', pdfPath, outputPrefix],
      { timeout: 120_000 },
    );

    // Collect output images (pdftoppm names them page-01.png, page-02.png, etc.)
    const images: Buffer[] = [];
    for (let i = 1; i <= 500; i++) {
      // pdftoppm zero-pads based on total pages; try common patterns
      const paddings = [1, 2, 3, 4, 5, 6];
      let found = false;
      for (const pad of paddings) {
        const candidate = join(workDir, `page-${String(i).padStart(pad, '0')}.png`);
        try {
          const img = readFileSync(candidate);
          images.push(img);
          found = true;
          break;
        } catch {
          // Try next candidate
        }
      }
      if (!found) break;
    }

    return { images, pageCount: images.length };
  } finally {
    cleanupTempDir(workDir);
  }
}

async function pdfToImagesViaPdfjs(
  buffer: Buffer,
): Promise<{ images: Buffer[]; pageCount: number }> {
  // Dynamic imports — canvas and pdfjs-dist may not be installed.
  // This is a best-effort fallback; pdftoppm is preferred.
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
  const canvasMod: any = await (Function('return import("canvas")')() as Promise<any>);
  const createCanvas = canvasMod.createCanvas;

  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
  const images: Buffer[] = [];

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 2.0 }); // 2x for OCR quality

    const canvas = createCanvas(viewport.width, viewport.height);
    const ctx = canvas.getContext('2d');

    await page.render({
      canvasContext: ctx,
      viewport,
    }).promise;

    images.push(canvas.toBuffer('image/png'));
  }

  return { images, pageCount: doc.numPages };
}

// ---------------------------------------------------------------------------
// OCR execution
// ---------------------------------------------------------------------------

interface OcrPageResult {
  page: number;
  text: string;
  confidence: number;
}

async function ocrImageNative(
  imageBuffer: Buffer,
  tesseractPath: string,
  pageNum: number,
): Promise<OcrPageResult> {
  const workDir = makeTempDir();
  const imgPath = join(workDir, 'page.png');
  const outBase = join(workDir, 'out');

  try {
    writeFileSync(imgPath, imageBuffer);

    execFileSync(
      tesseractPath,
      [imgPath, outBase, '-l', 'eng', '--psm', '3'],
      { timeout: 60_000 },
    );

    const text = readFileSync(`${outBase}.txt`, 'utf-8');

    // Native tesseract doesn't easily expose confidence per-page without
    // parsing hOCR/TSV output. Use a heuristic: if text is non-empty,
    // assume reasonable confidence.
    const confidence = text.trim().length > 10 ? 0.7 : 0.3;

    return { page: pageNum, text, confidence };
  } finally {
    cleanupTempDir(workDir);
  }
}

async function ocrImageTesseractJs(
  imageBuffer: Buffer,
  pageNum: number,
): Promise<OcrPageResult> {
  const tesseractMod = await import('tesseract.js');
  // tesseract.js module shape differs across versions/build targets.
  // Support both named and default-exported recognize APIs.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recognize = (tesseractMod.default as any)?.recognize
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ?? (tesseractMod as any).recognize;

  if (typeof recognize !== 'function') {
    throw new Error('Tesseract recognize API unavailable');
  }

  const { data } = await recognize(imageBuffer, 'eng');

  return {
    page: pageNum,
    text: data.text,
    confidence: data.confidence / 100, // Tesseract.js returns 0-100
  };
}

// ---------------------------------------------------------------------------
// Section detection for OCR text (simplified)
// ---------------------------------------------------------------------------

/** Patterns for numbered section headings */
const NUMBERED_HEADING_RE =
  /^(?:section\s+)?\d+(?:\.\d+)*\.?\s+[A-Z][A-Za-z\s,/&()-]+$/;

function isAllCapsHeading(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 4) return false;
  const letters = trimmed.replace(/[^A-Za-z]/g, '');
  if (letters.length < 2) return false;
  return letters === letters.toUpperCase() && /[A-Z]/.test(letters);
}

function isOcrHeading(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (isAllCapsHeading(trimmed)) return true;
  if (NUMBERED_HEADING_RE.test(trimmed)) return true;
  return false;
}

const LIST_ITEM_RE = [
  /^\s*\d+[.)]\s/,
  /^\s*[a-z][.)]\s/,
  /^\s*[•●○▪▸►-]\s/,
  /^\s*\*\s/,
];

function isListItem(line: string): boolean {
  return LIST_ITEM_RE.some((re) => re.test(line));
}

function detectOcrSections(
  pageTexts: OcrPageResult[],
): ExtractedSection[] {
  const sections: ExtractedSection[] = [];

  for (const pageResult of pageTexts) {
    const lines = pageResult.text.split('\n');
    let i = 0;

    while (i < lines.length) {
      const trimmed = lines[i].trim();

      if (!trimmed) {
        i++;
        continue;
      }

      // Heading
      if (isOcrHeading(trimmed)) {
        sections.push({
          title: trimmed,
          content: trimmed,
          page: pageResult.page,
          level: 1,
          type: 'heading',
        });
        i++;
        continue;
      }

      // List block
      if (isListItem(trimmed)) {
        const listLines: string[] = [];
        while (i < lines.length && isListItem(lines[i].trim())) {
          listLines.push(lines[i]);
          i++;
        }
        sections.push({
          title: null,
          content: listLines.join('\n').trim(),
          page: pageResult.page,
          type: 'list',
        });
        continue;
      }

      // Paragraph: collect contiguous non-empty lines
      const paraLines: string[] = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !isOcrHeading(lines[i].trim()) &&
        !isListItem(lines[i].trim())
      ) {
        paraLines.push(lines[i]);
        i++;
      }
      if (paraLines.length > 0) {
        sections.push({
          title: null,
          content: paraLines.join('\n').trim(),
          page: pageResult.page,
          type: 'paragraph',
        });
      }
    }
  }

  return sections;
}

/**
 * Run OCR on a single image buffer.
 *
 * Prefers native Tesseract binary if available, falls back to tesseract.js.
 */
export async function ocrImage(
  buffer: Buffer,
  filename: string,
): Promise<ExtractedContent> {
  try {
    const nativePath = findNativeTesseract();
    const pageResult = nativePath
      ? await ocrImageNative(buffer, nativePath, 1)
      : await ocrImageTesseractJs(buffer, 1);

    const sections = detectOcrSections([pageResult]);
    const confidence = Math.round(pageResult.confidence * 100) / 100;

    return {
      text: pageResult.text,
      sections,
      metadata: {
        filename,
        pages: 1,
        ocr_used: true,
        ocr_confidence: confidence,
        ocr_engine: nativePath ? 'native_tesseract' : 'tesseract_js',
        extraction_method: 'ocr_image',
      },
      ocr_used: true,
      ocr_confidence: confidence,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      text: '',
      sections: [],
      metadata: {
        filename,
        pages: 1,
        ocr_used: true,
        error: `Image OCR failed: ${message}`,
        extraction_method: 'ocr_image',
      },
      ocr_used: true,
      ocr_confidence: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Main OCR pipeline
// ---------------------------------------------------------------------------

/**
 * Run OCR on a PDF buffer: convert pages to images, then run Tesseract on each.
 *
 * Prefers native Tesseract binary if available, falls back to tesseract.js.
 */
export async function ocrPdf(
  buffer: Buffer,
  filename: string,
  onPageProgress?: (page: number, total: number) => void,
): Promise<ExtractedContent> {
  try {
    // Step 1: Convert PDF to images
    const { images, pageCount } = await pdfToImages(buffer);

    if (images.length === 0) {
      return {
        text: '',
        sections: [],
        metadata: {
          filename,
          pages: pageCount,
          ocr_used: true,
          error: 'Could not convert PDF pages to images. Install poppler-utils (pdftoppm) or pdfjs-dist+canvas for OCR support.',
          extraction_method: 'ocr',
        },
        ocr_used: true,
        ocr_confidence: 0,
      };
    }

    // Step 2: OCR each page
    const nativePath = findNativeTesseract();
    const pageResults: OcrPageResult[] = [];

    for (let i = 0; i < images.length; i++) {
      const pageNum = i + 1;
      onPageProgress?.(pageNum, images.length);

      try {
        const result = nativePath
          ? await ocrImageNative(images[i], nativePath, pageNum)
          : await ocrImageTesseractJs(images[i], pageNum);
        pageResults.push(result);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        pageResults.push({
          page: pageNum,
          text: '',
          confidence: 0,
        });
        // Log but continue — don't fail the whole document for one page
        console.warn(`OCR failed on page ${pageNum} of ${filename}: ${message}`);
      }
    }

    // Step 3: Assemble results
    const fullText = pageResults.map((p) => p.text).join('\n\n');
    const avgConfidence =
      pageResults.length > 0
        ? pageResults.reduce((sum, p) => sum + p.confidence, 0) / pageResults.length
        : 0;

    // Step 4: Section detection
    const sections = detectOcrSections(pageResults);

    return {
      text: fullText,
      sections,
      metadata: {
        filename,
        pages: pageCount,
        ocr_used: true,
        ocr_confidence: Math.round(avgConfidence * 100) / 100,
        ocr_engine: nativePath ? 'native_tesseract' : 'tesseract_js',
        ocr_pages_processed: pageResults.length,
        extraction_method: 'ocr',
      },
      ocr_used: true,
      ocr_confidence: Math.round(avgConfidence * 100) / 100,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      text: '',
      sections: [],
      metadata: {
        filename,
        pages: 0,
        ocr_used: true,
        error: `OCR pipeline failed: ${message}`,
        extraction_method: 'ocr',
      },
      ocr_used: true,
      ocr_confidence: 0,
    };
  }
}
