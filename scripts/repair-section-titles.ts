/**
 * Repair script: fix section_titles that were inherited from table row values
 * instead of the proper appendix heading.
 *
 * Pattern: PDF tables are extracted with rows classified as headings.
 * A short excluded chunk has the correct heading (e.g. "13.2.1 MICROBIOLOGY TEST CODES"),
 * but the following non-excluded chunk inherits a table row value as its section_title
 * (e.g., "APC/SPC 3" which is literally the first line of the content).
 *
 * Fix:
 *   1. Find non-excluded chunks where section_title === first non-empty line of content
 *      AND the immediately preceding chunk was excluded with an appendix-style heading.
 *   2. Update the section_title to the proper heading from the excluded predecessor.
 *   3. Update citation_label accordingly.
 *   4. Recompute the FTS search_text with the corrected section_title.
 *
 * Usage:
 *   npx tsx scripts/repair-section-titles.ts          # dry run (shows changes)
 *   npx tsx scripts/repair-section-titles.ts --write  # apply to DB
 */

import postgres from 'postgres';
import { config } from 'dotenv';

config({ path: '.env.local', quiet: true } as Parameters<typeof config>[0]);

const sql = postgres(process.env.DATABASE_URL!);
const write = process.argv.includes('--write');

interface ChunkRow {
  id: string;
  document_id: string;
  doc_title: string;
  chunk_index: number;
  section_title: string | null;
  content: string;
  citation_label: string | null;
  retrieval_excluded: boolean;
}

/** Return the first non-empty line of a string */
function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ''
  );
}

/** Does a section_title look like a proper appendix/section heading (not a table row)? */
function looksLikeProperHeading(title: string): boolean {
  // Heading patterns:
  //   "13.2.1 MICROBIOLOGY TEST CODES"
  //   "Appendix 13.2 ..."
  //   "13 APPENDIX"
  //   "13.1 FONTERRA SUPPLIER GROUP CODES"
  return /^\d+(\.\d+)*\s+\S/.test(title) || /appendix/i.test(title);
}

/**
 * Does a section_title look like a legitimate numbered section/subsection heading?
 * These should NOT be repaired even if they match the first line of content,
 * because they may legitimately represent subsection headings (e.g., "3.2 MILKOSCAN ZERO SETTING").
 */
function looksLikeNumberedSectionHeading(title: string): boolean {
  // Matches patterns like "3.2 MILKOSCAN ZERO SETTING", "8.1.1 DIRECT PLATING RESULT CALCULATION"
  // i.e., hierarchical number (digit.digit[.digit]) followed by a capital letter word
  return /^\d+(\.\d+)+\s+[A-Z]/.test(title);
}

async function main() {
  // Fetch all active document chunks ordered by document + chunk_index
  const allChunks = await sql<ChunkRow[]>`
    SELECT
      c.id,
      c.document_id,
      d.title AS doc_title,
      c.chunk_index,
      c.section_title,
      c.content,
      c.citation_label,
      c.retrieval_excluded
    FROM chunks c
    JOIN documents d ON d.id = c.document_id
    WHERE d.is_active = true
    ORDER BY c.document_id, c.chunk_index
  `;

  console.error(`Loaded ${allChunks.length} chunks across all active documents`);

  interface Repair {
    id: string;
    docTitle: string;
    chunkIndex: number;
    oldTitle: string | null;
    newTitle: string;
    oldCitation: string | null;
    newCitation: string;
  }

  const repairs: Repair[] = [];

  // Group by document_id
  const byDoc = new Map<string, ChunkRow[]>();
  for (const c of allChunks) {
    if (!byDoc.has(c.document_id)) byDoc.set(c.document_id, []);
    byDoc.get(c.document_id)!.push(c);
  }

  for (const chunks of byDoc.values()) {
    // chunks are already ordered by chunk_index
    for (let i = 1; i < chunks.length; i++) {
      const current = chunks[i];
      const prev = chunks[i - 1];

      // Skip if already excluded (won't affect retrieval)
      if (current.retrieval_excluded) continue;

      // Skip if no section_title to fix
      if (!current.section_title) continue;

      // Skip if the current section_title looks like a real numbered section heading
      // (e.g. "3.2 MILKOSCAN ZERO SETTING", "8.1.1 DIRECT PLATING RESULT CALCULATION")
      // Those should NOT be replaced by a parent-section heading.
      if (looksLikeNumberedSectionHeading(current.section_title)) continue;

      // Check: section_title equals the first line of content (table row as heading)
      const fl = firstLine(current.content);
      if (!fl || current.section_title.trim() !== fl) continue;

      // Check: predecessor is excluded and has a proper appendix heading
      if (!prev.retrieval_excluded) continue;
      if (!prev.section_title || !looksLikeProperHeading(prev.section_title)) continue;

      // Skip if the predecessor's heading looks like a TOC entry (contains dots run)
      if (/\.{3,}/.test(prev.section_title)) continue;

      // Repair needed
      const newTitle = prev.section_title;
      const newCitation = `${current.doc_title}, ${newTitle}`;

      repairs.push({
        id: current.id,
        docTitle: current.doc_title,
        chunkIndex: current.chunk_index,
        oldTitle: current.section_title,
        newTitle,
        oldCitation: current.citation_label,
        newCitation,
      });
    }
  }

  console.error(`\nFound ${repairs.length} chunks to repair`);

  if (repairs.length === 0) {
    console.log(JSON.stringify({ repaired: 0 }));
    await sql.end();
    return;
  }

  // Show sample
  const sample = repairs.slice(0, 20);
  for (const r of sample) {
    console.error(
      `  [${r.docTitle}] chunk ${r.chunkIndex}: "${r.oldTitle}" → "${r.newTitle}"`,
    );
  }
  if (repairs.length > 20) {
    console.error(`  ... and ${repairs.length - 20} more`);
  }

  if (!write) {
    console.log(
      JSON.stringify({
        dry_run: true,
        would_repair: repairs.length,
        sample: sample.map((r) => ({
          doc: r.docTitle,
          chunk_index: r.chunkIndex,
          old_title: r.oldTitle,
          new_title: r.newTitle,
        })),
      }),
    );
    await sql.end();
    return;
  }

  // Apply repairs in batches
  let repaired = 0;
  const BATCH = 50;

  for (let i = 0; i < repairs.length; i += BATCH) {
    const batch = repairs.slice(i, i + BATCH);

    await sql.begin(async (tx) => {
      for (const r of batch) {
        await tx`
          UPDATE chunks
          SET
            section_title   = ${r.newTitle},
            citation_label  = ${r.newCitation},
            -- Recompute FTS search_text with corrected section_title + citation_label
            search_text     = setweight(to_tsvector('english', coalesce(${r.newCitation}, '')), 'A')
                           || setweight(to_tsvector('english', coalesce(${r.newTitle}, '')), 'A')
                           || setweight(to_tsvector('english', content), 'C')
          WHERE id = ${r.id}
        `;
        repaired++;
      }
    });
  }

  console.log(
    JSON.stringify({
      repaired,
      sample: sample.map((r) => ({
        doc: r.docTitle,
        chunk_index: r.chunkIndex,
        old_title: r.oldTitle,
        new_title: r.newTitle,
      })),
    }),
  );

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
