import { config } from 'dotenv';
import postgres from 'postgres';
import { auditPdfCompleteness } from '../src/lib/pdfCompleteness';

config({ path: '.env.local', quiet: true });

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set.');
}

const sql = postgres(process.env.DATABASE_URL, {
  max: 5,
  idle_timeout: 20,
  connect_timeout: 10,
});

type DocRow = {
  id: string;
  title: string;
  source_path: string;
  extraction_method: string | null;
  text_quality_tier: 'good' | 'partial' | 'poor' | null;
  text_quality_score: string | null;
  needs_review: boolean;
  quarantined: boolean;
  chunk_count: number;
};

type ChunkRow = {
  page_number: number | null;
  section_title: string | null;
  content: string;
};

async function fetchActivePdfDocs(): Promise<DocRow[]> {
  return sql<DocRow[]>`
    select id, title, source_path, extraction_method, text_quality_tier, text_quality_score,
           needs_review, quarantined, chunk_count
    from documents
    where is_active = true and source_type = 'pdf'
    order by title asc
  `;
}

async function fetchChunksForDoc(documentId: string): Promise<ChunkRow[]> {
  return sql<ChunkRow[]>`
    select page_number, section_title, content
    from chunks
    where document_id = ${documentId}
    order by chunk_index asc
  `;
}

function mapStatus(risk: 'low' | 'medium' | 'high'): 'complete' | 'partial' | 'suspect' {
  if (risk === 'high') return 'suspect';
  if (risk === 'medium') return 'partial';
  return 'complete';
}

async function persistAudit(
  rows: Array<{
    id: string;
    risk: 'low' | 'medium' | 'high';
    risk_score: number;
    reasons: string[];
    missing_referenced_appendices: string[];
  }>,
): Promise<void> {
  for (const row of rows) {
    await sql`
      update documents
      set extraction_completeness_status = ${mapStatus(row.risk)},
          extraction_completeness_score = ${row.risk_score},
          extraction_completeness_reasons = ${sql.json(row.reasons)},
          missing_referenced_appendices = ${sql.json(row.missing_referenced_appendices)},
          completeness_last_audited_at = now(),
          updated_at = now()
      where id = ${row.id}
    `;
  }
}

function summarize(
  results: Array<{
    title: string;
    source_path: string;
    risk: 'low' | 'medium' | 'high';
    risk_score: number;
    reasons: string[];
    missing_referenced_appendices: string[];
    chunk_count: number;
    avg_chars_per_chunk: number;
  }>,
) {
  const high = results.filter((r) => r.risk === 'high');
  const medium = results.filter((r) => r.risk === 'medium');
  const low = results.filter((r) => r.risk === 'low');

  return {
    total_pdf_docs: results.length,
    high_risk: high.length,
    medium_risk: medium.length,
    low_risk: low.length,
    high_risk_docs: high.map((r) => ({
      title: r.title,
      source_path: r.source_path,
      risk_score: r.risk_score,
      reasons: r.reasons,
      missing_referenced_appendices: r.missing_referenced_appendices,
      chunk_count: r.chunk_count,
      avg_chars_per_chunk: r.avg_chars_per_chunk,
    })),
    medium_risk_docs: medium.slice(0, 30).map((r) => ({
      title: r.title,
      source_path: r.source_path,
      risk_score: r.risk_score,
      reasons: r.reasons,
      missing_referenced_appendices: r.missing_referenced_appendices,
      chunk_count: r.chunk_count,
      avg_chars_per_chunk: r.avg_chars_per_chunk,
    })),
  };
}

async function main() {
  const writeMode = process.argv.includes('--write');

  const docs = await fetchActivePdfDocs();
  const results: Array<ReturnType<typeof auditPdfCompleteness> & { id: string }> = [];

  for (const doc of docs) {
    const chunks = await fetchChunksForDoc(doc.id);
    const result = auditPdfCompleteness(
      {
        title: doc.title,
        source_path: doc.source_path,
        extraction_method: doc.extraction_method,
        text_quality_tier: doc.text_quality_tier,
        text_quality_score: doc.text_quality_score ? Number(doc.text_quality_score) : null,
        needs_review: doc.needs_review,
        quarantined: doc.quarantined,
        chunk_count: doc.chunk_count,
      },
      chunks,
    );

    results.push({
      id: doc.id,
      ...result,
    });
  }

  results.sort((a, b) => b.risk_score - a.risk_score || a.title.localeCompare(b.title));

  if (writeMode) {
    await persistAudit(results.map((r) => ({
      id: r.id,
      risk: r.risk,
      risk_score: r.risk_score,
      reasons: r.reasons,
      missing_referenced_appendices: r.missing_referenced_appendices,
    })));
  }

  const report = {
    generated_at: new Date().toISOString(),
    write_mode: writeMode,
    summary: summarize(results),
    docs: results,
  };

  console.log(JSON.stringify(report, null, 2));
}

main()
  .catch((error) => {
    console.error('PDF completeness audit failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await sql.end();
  });
