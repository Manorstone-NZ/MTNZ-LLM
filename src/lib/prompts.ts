import type { CitedChunk } from './types';

export const SYSTEM_PROMPT = `You are an IDD knowledge assistant for the MTNZ LIMS replacement programme.

RULES:
- Answer ONLY from the provided source chunks. Do not use prior knowledge.
- Cite every substantive claim using [Source: citation_label] where citation_label is the exact label from the provided chunks.
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
    let header = `[Chunk ${i + 1}] ${c.citation_label}`;
    if (c.doc_title) header += ` | Doc: ${c.doc_title}`;
    if (c.folder) header += ` | Folder: ${c.folder}`;
    if (c.page) header += ` | Page: ${c.page}`;
    if (c.section_title) header += ` | Section: ${c.section_title}`;
    if (c.sheet_name) header += ` | Sheet: ${c.sheet_name}`;
    return `${header}\n${c.content}`;
  }).join('\n\n---\n\n');

  return `## Retrieved Source Chunks\n\n${chunkContext}\n\n---\n\n## Question\n\n${question}`;
}

export const LOW_CONFIDENCE_CAVEAT =
  "Note: The following answer is based on limited evidence. The retrieved sources may not fully address your question.\n\n";

export const NO_EVIDENCE_MESSAGE =
  "No grounded evidence found in the document corpus for this question.";
