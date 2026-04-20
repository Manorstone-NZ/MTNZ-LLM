import type { CitedChunk, ScoredChunk } from './types';

const STRUCTURED_SOURCE_TYPES = new Set(['xlsx', 'csv']);

const AUTHORITATIVE_TITLE_REGEX =
  /\b(list|code|appendix|matrix|mapping|register|reference|catalog|catalogue|lookup|table)\b/i;

const AUTHORITATIVE_SECTION_REGEX =
  /\b(codes?|test\s*types?|appendix|criteria|rules?|release|interpretation|forms?|mapping|register|reference)\b/i;

const CATALOGUE_QUERY_REGEX =
  /\b(show\s+all|full\s+list|list|catalog|catalogue|codes?|test\s*types?|programs?|programmes?|forms?|mappings?|registers?|appendix|appendices|reference\s+table|lookup\s+table|matrix)\b/i;

const CANONICAL_QUERY_REGEX =
  /\b(canonical|master|authoritative|official|reference\s+source|source\s+of\s+truth|lookup|mapping|register|matrix|code\s+list|test\s+type\s+list)\b/i;

const MAPPING_WHICH_FOR_WHICH_REGEX =
  /\bwhich\s+[\w\s/-]+\s+(?:are|is|were|was|performed|used|mapped|assigned|available)?\s*(?:for|to)\s+which\s+[\w\s/-]+\b/i;

const MAPPING_WHICH_HAS_WHICH_REGEX =
  /\bwhich\s+[\w\s/-]+\s+has\s+which\s+[\w\s/-]+\b/i;

const MAPPING_MAP_TO_REGEX =
  /\bmap(?:ping)?\s+[\w\s/-]+\s+to\s+[\w\s/-]+\b/i;

const MAPPING_ASSOCIATION_REGEX =
  /\bassociations?\s+(?:between|for)\s+[\w\s/-]+\s+(?:and|to)\s+[\w\s/-]+\b/i;

const MAPPING_ENTITY_PAIR_ASSOCIATION_REGEX =
  /\b(?:customer|client|database|system|site|instrument|business\s+unit)(?:\s*\/\s*|-)\s*(?:customer|client|database|system|site|instrument|business\s+unit)\s+associations?\b/i;

const MAPPING_BREAKDOWN_REGEX =
  /\b(?:(?:tests?|test\s*types?|codes?|programmes?|programs?|databases?|systems?|sites?|customers?|clients?|instruments?|business\s+units?)\s*-\s*by\s*-\s*(?:tests?|test\s*types?|codes?|programmes?|programs?|databases?|systems?|sites?|customers?|clients?|instruments?|business\s+units?)|breakdown\s+by\s+(?:customer|client|database|system|site|instrument|business\s+unit)|(?:tests?|test\s*types?|codes?|programmes?|programs?|databases?|systems?|sites?)\s+by\s+(?:customer|client|database|system|site|instrument|business\s+unit))\b/i;

const RULES_QUERY_REGEX =
  /\b(rule|rules|validation|validations|processing\s+logic|business\s+rules|decision\s+logic|criteria|conditions|govern|release\s+rules|entry\s+rules|result\s+entry\s+rules|validation\s+conditions)\b/i;

const LIST_SIGNAL_REGEX =
  /\b(list|catalog|catalogue|codes?|test\s*types?|programs?|programmes?|forms?|mapping|register|reference\s+table|lookup\s+table)\b/i;

const RULE_SIGNAL_REGEX =
  /\b(must|shall|required|if|when|only if|enter|reject|accept|notify|adjust|release|confirm|criteria|condition|validation|code|result code|limit|threshold|range)\b/i;

export function isStructuredSourceType(sourceType?: string): boolean {
  if (!sourceType) return false;
  return STRUCTURED_SOURCE_TYPES.has(sourceType.toLowerCase());
}

export function isAuthoritativeTitle(title?: string): boolean {
  if (!title) return false;
  return AUTHORITATIVE_TITLE_REGEX.test(title);
}

export function isAuthoritativeSectionTitle(sectionTitle?: string | null): boolean {
  if (!sectionTitle) return false;
  return AUTHORITATIVE_SECTION_REGEX.test(sectionTitle);
}

export function isAuthoritativeChunkCandidate(chunk: Pick<ScoredChunk, 'source_type' | 'doc_title' | 'section_title'>): boolean {
  return (
    isStructuredSourceType(chunk.source_type) ||
    isAuthoritativeTitle(chunk.doc_title) ||
    isAuthoritativeSectionTitle(chunk.section_title)
  );
}

export function isCatalogueStyleQuery(input: string): boolean {
  return CATALOGUE_QUERY_REGEX.test(input);
}

export function isMappingStyleQuery(input: string): boolean {
  return (
    MAPPING_WHICH_FOR_WHICH_REGEX.test(input) ||
    MAPPING_WHICH_HAS_WHICH_REGEX.test(input) ||
    MAPPING_MAP_TO_REGEX.test(input) ||
    MAPPING_ASSOCIATION_REGEX.test(input) ||
    MAPPING_ENTITY_PAIR_ASSOCIATION_REGEX.test(input) ||
    MAPPING_BREAKDOWN_REGEX.test(input)
  );
}

export function isCanonicalLookupQuery(input: string): boolean {
  return CANONICAL_QUERY_REGEX.test(input) || isMappingStyleQuery(input);
}

export function isRulesStyleQuery(input: string): boolean {
  return RULES_QUERY_REGEX.test(input);
}

export function hasListSignal(text: string): boolean {
  return LIST_SIGNAL_REGEX.test(text);
}

export function hasRuleSignal(text: string): boolean {
  return RULE_SIGNAL_REGEX.test(text);
}

export function summariseAuthoritativeCoverage(chunks: CitedChunk[]): {
  structuredSourceCount: number;
  authoritativeChunkCount: number;
  listSignalCount: number;
  ruleSignalCount: number;
} {
  let structuredSourceCount = 0;
  let authoritativeChunkCount = 0;
  let listSignalCount = 0;
  let ruleSignalCount = 0;

  for (const chunk of chunks) {
    if (isStructuredSourceType(chunk.source_type)) {
      structuredSourceCount += 1;
    }

    if (
      isStructuredSourceType(chunk.source_type) ||
      isAuthoritativeTitle(chunk.doc_title) ||
      isAuthoritativeSectionTitle(chunk.section_title)
    ) {
      authoritativeChunkCount += 1;
    }

    const corpus = `${chunk.section_title || ''} ${chunk.content_preview || ''}`;
    if (hasListSignal(corpus)) listSignalCount += 1;
    if (hasRuleSignal(corpus)) ruleSignalCount += 1;
  }

  return {
    structuredSourceCount,
    authoritativeChunkCount,
    listSignalCount,
    ruleSignalCount,
  };
}