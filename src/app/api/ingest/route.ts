import { NextRequest } from 'next/server';
import { stat } from 'fs/promises';
import { ingestDocuments } from '@/lib/ingestion';
import { deactivateDocument } from '@/lib/repositories/documents';
import sql from '@/lib/db';

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { action, documentId, confirm, sourcePath } = body as {
    action?: string;
    documentId?: string;
    confirm?: string;
    sourcePath?: string;
  };

  if (!action) {
    return Response.json({ error: 'action is required' }, { status: 400 });
  }

  // --- remove: synchronous JSON response ---
  if (action === 'remove') {
    if (!documentId) {
      return Response.json(
        { error: 'documentId is required for remove action' },
        { status: 400 }
      );
    }
    try {
      await deactivateDocument(documentId);
      return Response.json({ ok: true, documentId });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to remove document';
      return Response.json({ error: message }, { status: 500 });
    }
  }

  // --- Validate actions that need streaming ---
  if (action === 'reprocess_one' && !documentId) {
    return Response.json(
      { error: 'documentId is required for reprocess_one action' },
      { status: 400 }
    );
  }

  if (action === 'full_rebuild' && confirm !== 'REBUILD') {
    return Response.json(
      { error: 'full_rebuild requires confirm: "REBUILD"' },
      { status: 400 }
    );
  }

  if (!['ingest_new', 'reprocess_one', 'full_rebuild'].includes(action)) {
    return Response.json({ error: `Unknown action: ${action}` }, { status: 400 });
  }

  // --- Streaming SSE response for long-running actions ---
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const push = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(sseEvent(event, data)));
      };

      try {
        const requestedSourcePath = sourcePath?.trim();
        const ingestSourcePath = requestedSourcePath || process.env.SOURCE_PATH;

        if (!ingestSourcePath) {
          push('error', {
            message: 'SOURCE_PATH is not configured and no sourcePath override was provided',
            code: 'CONFIG_ERROR',
          });
          controller.close();
          return;
        }

        try {
          const sourceStats = await stat(ingestSourcePath);
          if (!sourceStats.isDirectory()) {
            push('error', {
              message: `Ingest source path is not a directory: ${ingestSourcePath}`,
              code: 'INVALID_SOURCE_PATH',
            });
            controller.close();
            return;
          }
        } catch {
          push('error', {
            message: `Ingest source path does not exist: ${ingestSourcePath}`,
            code: 'INVALID_SOURCE_PATH',
          });
          controller.close();
          return;
        }

        if (action === 'full_rebuild') {
          // Delete all documents and chunks, then run full ingest
          push('progress', { file: '', status: 'clearing_database', processed: 0, total: 0 });
          await sql`DELETE FROM chunks`;
          await sql`DELETE FROM documents`;
          await sql`DELETE FROM ingest_runs`;
          push('progress', { file: '', status: 'database_cleared', processed: 0, total: 0 });
        }

        let singleFile: string | undefined;
        if (action === 'reprocess_one' && documentId) {
          // Look up the source_path for this document
          const [doc] = await sql<{ source_path: string }[]>`
            SELECT source_path FROM documents WHERE id = ${documentId} LIMIT 1
          `;
          if (!doc) {
            push('error', { message: `Document not found: ${documentId}`, code: 'NOT_FOUND' });
            controller.close();
            return;
          }
          singleFile = doc.source_path;
        }

        const result = await ingestDocuments({
          sourcePath: ingestSourcePath,
          forceReprocess: action === 'reprocess_one' || action === 'full_rebuild',
          singleFile,
          onProgress: (event) => {
            push('progress', event);
          },
        });

        push('done', { ok: true, result });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Ingest failed';
        // Detect run lock conflict
        if (message.includes('Ingest already running')) {
          push('error', { message, code: 'CONFLICT' });
        } else {
          push('error', { message, code: 'INTERNAL_ERROR' });
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: action === 'full_rebuild' ? 200 : 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
