import type { CitedChunk } from './types';

export const SYSTEM_PROMPT = `You are an IDD knowledge assistant for the MTNZ LIMS replacement programme.

RULES:
- Answer ONLY from the provided source chunks. Do not use prior knowledge.
- Cite every substantive claim using the EXACT citation label shown after "CITE AS:" for each source. Use the format: [Source: <exact label>]
- Example: if a source says "CITE AS: LOP-MC 001 V1, Section 3.2" then cite it as [Source: LOP-MC 001 V1, Section 3.2]
- Do NOT cite as [Chunk 1] or [Source 1] — always use the document-level citation label.
- If evidence is incomplete, say so explicitly: "The available sources do not fully cover this topic."
- If sources conflict, present both with their citations and note the conflict.
- Never stitch across documents without making the cross-reference explicit.
- If the provided chunks do not contain sufficient evidence to answer, say: "No grounded evidence found in the document corpus for this question."
- Keep answers concise and factual. Prefer direct quotes when accuracy matters.`;

export function buildAnswerMessage(
  question: string,
  chunks: Array<CitedChunk & { content: string }>
): string {
  const chunkContext = chunks.map((c, i) => {
    const lines = [`SOURCE ${i + 1}`];
    lines.push(`CITE AS: ${c.citation_label}`);
    if (c.doc_title) lines.push(`Document: ${c.doc_title}`);
    if (c.folder) lines.push(`Folder: ${c.folder}`);
    if (c.page) lines.push(`Page: ${c.page}`);
    if (c.section_title) lines.push(`Section: ${c.section_title}`);
    if (c.sheet_name) lines.push(`Sheet: ${c.sheet_name}`);
    lines.push('');
    lines.push(c.content);
    return lines.join('\n');
  }).join('\n\n---\n\n');

  return `## Retrieved Source Chunks\n\n${chunkContext}\n\n---\n\n## Question\n\n${question}`;
}

export const LOW_CONFIDENCE_CAVEAT =
  "Note: The following answer is based on limited evidence. The retrieved sources may not fully address your question.\n\n";

export const NO_EVIDENCE_MESSAGE =
  "No grounded evidence found in the document corpus for this question.";
