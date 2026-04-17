import { readFile } from 'fs/promises';
import { join, normalize, resolve } from 'path';
import sql from '@/lib/db';

const MIME_BY_SOURCE_TYPE: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
};

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const [doc] = await sql<{ source_path: string; source_type: string; is_active: boolean }[]>`
      SELECT source_path, source_type, is_active
      FROM documents
      WHERE id = ${id}
      LIMIT 1
    `;

    if (!doc || !doc.is_active) {
      return Response.json({ error: 'Document not found' }, { status: 404 });
    }

    const mimeType = MIME_BY_SOURCE_TYPE[(doc.source_type || '').toLowerCase()];
    if (!mimeType) {
      return Response.json({ error: 'Preview not available for this file type' }, { status: 400 });
    }

    const sourceRoot = process.env.SOURCE_PATH;
    if (!sourceRoot) {
      return Response.json({ error: 'SOURCE_PATH not configured' }, { status: 500 });
    }

    const cleanedSourcePath = normalize(doc.source_path).replace(/^([/\\])+/, '');
    const absolutePath = resolve(join(sourceRoot, cleanedSourcePath));
    const resolvedRoot = resolve(sourceRoot);
    const isWithinRoot = absolutePath === resolvedRoot || absolutePath.startsWith(`${resolvedRoot}/`);
    if (!isWithinRoot) {
      return Response.json({ error: 'Invalid source path' }, { status: 400 });
    }

    const fileBuffer = await readFile(absolutePath);
    return new Response(fileBuffer, {
      headers: {
        'Content-Type': mimeType,
        'Cache-Control': 'private, max-age=300',
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load preview';
    return Response.json({ error: message }, { status: 500 });
  }
}