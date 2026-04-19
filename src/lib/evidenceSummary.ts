import type { CitedChunk } from '@/lib/types';
import { summariseAuthoritativeCoverage } from '@/lib/authoritativeSources';

export interface EvidenceSummary {
  documentCount: number;
  chunkCount: number;
  sectionTitleCount: number;
  ruleSignalCount: number;
  listSignalCount: number;
  authoritativeChunkCount: number;
  structuredSourceCount: number;
  ruleCategoryCount: number;
  hasStrongSynthesisCoverage: boolean;
  hasAuthoritativeSource: boolean;
  hasBroadRuleCoverage: boolean;
}

const RULE_SIGNAL_REGEX =
  /\b(must|shall|required|if|when|only if|enter|reject|accept|notify|adjust|release|confirm|criteria|condition|validation|code|result code|limit|threshold|range)\b/i;

const RULE_CATEGORY_PATTERNS: RegExp[] = [
  /\b(system|configuration|partition|database|access)\b/i,
  /\b(sample|classification|eligibility)\b/i,
  /\b(data\s*entry|manual\s*entry|field|format)\b/i,
  /\b(result\s*entry|adjust|amend|correction)\b/i,
  /\b(instrument|program|programme|method)\b/i,
  /\b(release|report|approval|approve)\b/i,
  /\b(exception|escalation|reject|notify|out\s*of\s*range)\b/i,
];

export function summariseRuleEvidence(chunks: CitedChunk[]): EvidenceSummary {
  const docKeys = new Set(chunks.map((c) => `${c.doc_title}|||${c.folder || ''}`));

  const sectionTitleCount = chunks.filter(
    (c) => typeof c.section_title === 'string' && c.section_title.trim().length > 0
  ).length;

  const ruleSignalCount = chunks.filter((c) =>
    RULE_SIGNAL_REGEX.test(`${c.section_title || ''} ${c.content_preview || ''}`)
  ).length;

  const categoryHits = new Set<number>();
  const authoritativeCoverage = summariseAuthoritativeCoverage(chunks);
  chunks.forEach((c) => {
    const corpus = `${c.section_title || ''} ${c.content_preview || ''}`;
    RULE_CATEGORY_PATTERNS.forEach((pattern, idx) => {
      if (pattern.test(corpus)) categoryHits.add(idx);
    });
  });

  const ruleCategoryCount = categoryHits.size;
  const hasAuthoritativeSource =
    authoritativeCoverage.structuredSourceCount > 0 ||
    authoritativeCoverage.authoritativeChunkCount >= 2;

  const hasStrongSynthesisCoverage =
    docKeys.size >= 2 &&
    chunks.length >= 6 &&
    (
      hasAuthoritativeSource ||
      authoritativeCoverage.listSignalCount >= 3 ||
      ruleCategoryCount >= 3
    );

  const hasBroadRuleCoverage =
    ruleCategoryCount >= 3 && docKeys.size >= 2 && chunks.length >= 6 && ruleSignalCount >= 4;

  return {
    documentCount: docKeys.size,
    chunkCount: chunks.length,
    sectionTitleCount,
    ruleSignalCount,
    listSignalCount: authoritativeCoverage.listSignalCount,
    authoritativeChunkCount: authoritativeCoverage.authoritativeChunkCount,
    structuredSourceCount: authoritativeCoverage.structuredSourceCount,
    ruleCategoryCount,
    hasStrongSynthesisCoverage,
    hasAuthoritativeSource,
    hasBroadRuleCoverage,
  };
}
