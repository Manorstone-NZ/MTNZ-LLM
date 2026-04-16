import { NextRequest } from 'next/server';
import { getDocumentInventory, getHealthMetrics } from '@/lib/repositories/documents';

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const folder = searchParams.get('folder') ?? undefined;
  const status = searchParams.get('status') ?? undefined;
  const type = searchParams.get('type') ?? undefined;

  try {
    const [documents, health] = await Promise.all([
      getDocumentInventory({ folder, status, type }),
      getHealthMetrics(),
    ]);

    return Response.json({ documents, health });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to fetch documents';
    return Response.json({ error: message }, { status: 500 });
  }
}
