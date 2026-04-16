import { embedText } from './embeddings';
import {
  vectorSearch,
  fullTextSearch,
  trigramSearch,
} from './repositories/chunks';
import type { ScoredChunk } from './types';

/**
 * Min-max normalize an array of scores to [0, 1].
 * If all scores are equal or there is only one result, returns 1.0 for all.
 */
function minMaxNormalize(scores: number[]): number[] {
  if (scores.length <= 1) return scores.map(() => 1.0);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  if (max === min) return scores.map(() => 1.0);
  return scores.map((s) => (s - min) / (max - min));
}

export async function hybridSearch(query: string): Promise<ScoredChunk[]> {
  const topK = parseInt(process.env.TOP_K_CANDIDATES || '25', 10);
  const topKFinal = parseInt(process.env.TOP_K_FINAL || '8', 10);
  const wVec = parseFloat(process.env.VECTOR_WEIGHT || '0.5');
  const wFts = parseFloat(process.env.FTS_WEIGHT || '0.3');
  const wTrgm = parseFloat(process.env.TRIGRAM_WEIGHT || '0.2');

  // Embed query and run all three searches in parallel
  const queryEmbedding = await embedText(query);

  const [vecResults, ftsResults, trgResults] = await Promise.all([
    vectorSearch(queryEmbedding, topK),
    fullTextSearch(query, topK),
    trigramSearch(query, topK),
  ]);

  // Normalize each result set
  const vecNorm = minMaxNormalize(vecResults.map((r) => r.vector_score ?? r.score));
  const ftsNorm = minMaxNormalize(ftsResults.map((r) => r.fts_score ?? r.score));
  const trgNorm = minMaxNormalize(trgResults.map((r) => r.trigram_score ?? r.score));

  // Merge by chunk ID
  const merged = new Map<string, ScoredChunk & { _vecNorm: number; _ftsNorm: number; _trgNorm: number }>();

  function ensureEntry(chunk: ScoredChunk) {
    if (!merged.has(chunk.id)) {
      merged.set(chunk.id, {
        ...chunk,
        vector_score: undefined,
        fts_score: undefined,
        trigram_score: undefined,
        score: 0,
        _vecNorm: 0,
        _ftsNorm: 0,
        _trgNorm: 0,
      });
    }
    return merged.get(chunk.id)!;
  }

  vecResults.forEach((chunk, i) => {
    const entry = ensureEntry(chunk);
    entry._vecNorm = vecNorm[i];
  });

  ftsResults.forEach((chunk, i) => {
    const entry = ensureEntry(chunk);
    entry._ftsNorm = ftsNorm[i];
  });

  trgResults.forEach((chunk, i) => {
    const entry = ensureEntry(chunk);
    entry._trgNorm = trgNorm[i];
  });

  // Compute fusion score and populate final fields
  const results: ScoredChunk[] = [];
  for (const entry of merged.values()) {
    const fusionScore =
      wVec * entry._vecNorm + wFts * entry._ftsNorm + wTrgm * entry._trgNorm;

    results.push({
      id: entry.id,
      document_id: entry.document_id,
      content: entry.content,
      content_preview: entry.content_preview,
      citation_label: entry.citation_label,
      section_title: entry.section_title,
      sheet_name: entry.sheet_name,
      page_number: entry.page_number,
      doc_title: entry.doc_title,
      folder: entry.folder,
      score: fusionScore,
      vector_score: entry._vecNorm || undefined,
      fts_score: entry._ftsNorm || undefined,
      trigram_score: entry._trgNorm || undefined,
    });
  }

  // Sort descending by fusion score, return top K
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topKFinal);
}
