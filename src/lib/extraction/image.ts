import type { ExtractedContent } from '../types';
import { ocrImage } from './ocr';

/**
 * Extract text from image files via OCR.
 */
export async function extractImage(
  buffer: Buffer,
  filename: string,
): Promise<ExtractedContent> {
  if (buffer.length === 0) {
    return {
      text: '',
      sections: [],
      metadata: {
        filename,
        pages: 1,
        ocr_used: true,
        error: 'Image OCR failed: empty image buffer',
        extraction_method: 'ocr_image',
      },
      ocr_used: true,
      ocr_confidence: 0,
    };
  }

  return ocrImage(buffer, filename);
}