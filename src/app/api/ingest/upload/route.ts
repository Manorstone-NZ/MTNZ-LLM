import { randomUUID } from 'crypto';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import { NextRequest } from 'next/server';

const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';
const SUPPORTED_EXTENSIONS = new Set([
  '.pdf',
  '.docx',
  '.xlsx',
  '.txt',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.webp',
  '.tif',
  '.tiff',
]);

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return Response.json({ error: 'No file provided' }, { status: 400 });
    }

    // Validate file extension
    const filename = file.name;
    const ext = filename.substring(filename.lastIndexOf('.')).toLowerCase();

    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      return Response.json(
        {
          error: `Unsupported file format: ${ext}. Supported formats: PDF, DOCX, XLSX, TXT, PNG, JPG, GIF, WebP, TIFF`,
        },
        { status: 400 }
      );
    }

    // Validate file size (100MB max)
    const MAX_SIZE = 100 * 1024 * 1024;
    if (file.size > MAX_SIZE) {
      return Response.json(
        {
          error: `File too large: ${Math.round(file.size / 1024 / 1024)}MB. Max: 100MB`,
        },
        { status: 400 }
      );
    }

    // Read file into buffer
    const buffer = Buffer.from(await file.arrayBuffer());

    // Generate unique filename with timestamp and UUID to prevent collisions
    const timestamp = Date.now();
    const uniqueId = randomUUID().substring(0, 8);
    const basename = filename.substring(0, filename.lastIndexOf('.'));
    const savedFilename = `${timestamp}-${uniqueId}-${basename}${ext}`;
    const filepath = join(UPLOAD_DIR, savedFilename);

    // Write to disk
    await writeFile(filepath, buffer);

    return Response.json({
      ok: true,
      file: filename,
      savedAs: savedFilename,
      path: filepath,
      size: buffer.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Upload failed';
    return Response.json({ error: message }, { status: 500 });
  }
}
