import { embedText } from './embeddings';
import {
  vectorSearch,
  fullTextSearch,
  trigramSearch,
  findChunksBySectionRefs,
  findListPriorityChunks,
  findAuthoritativeChunks,
} from './repositories/chunks';
import { prepareQuery } from './queryPrep';
import type { RetrievalMode } from './retrievalMode';
import type { ScoredChunk } from './types';
import {
  hasRuleSignal,
  isAuthoritativeChunkCandidate,
  isCanonicalLookupQuery,
  isCatalogueStyleQuery,
  isStructuredSourceType,
} from './authoritativeSources';
import { buildRegistryQueryExpansion, getRegistrySourceBoost } from './entityRegistry';
import { extractInteractionEntityPair } from './queryIntent';

const LIST_PRIORITY_REGEX = /\b(test\s*codes?|full list|show all|all tests?|list)\b/i;
const LIST_EVIDENCE_REGEX = /\b(test\s*codes?|test\s*types?|programmes?|programs?|result\s*codes?)\b/i;
const RULES_PRIORITY_REGEX =
  /\b(rule|rules|validation|validations|processing logic|business rules|decision logic|criteria|conditions|govern|release rules|entry rules|result entry rules|validation conditions)\b/i;
const RULE_SIGNAL_REGEX =
  /\b(must|shall|required|if|when|only if|enter|reject|accept|notify|adjust|release|confirm|limit|threshold|range|code|result code|criteria|condition|validation)\b/i;

// Mechanism-focused interaction signal excludes system names to avoid false positives.
const INTERACTION_MECHANISM_REGEX =
  /\b(integration|interface|web\s*service|api|middleware|automatic\s*(?:data\s*)?entry|import|export|file\s*transfer|setup|configuration|connection|protocol|trigger|flow|exchange|result\s*entry|compile|transmit|queue|request|return)\b/i;

const INTERACTION_SETUP_SECTION_REGEX =
  /\b(setup|interface|configuration|connection|integration|import|export|automatic|middleware|web\s*service|api|instrument)\b/i;

const INTERACTION_TRANSFER_VERB_REGEX =
  /\b(send|sends|receive|receives|import|imports|export|exports|request|requests|return|returns|compile|compiles|release|releases|transmit|transmits|feed|feeds)\b/i;

const INTERACTION_DEPENDENCY_REGEX =
  /\b(must|required|if|when|fail|fails|failed|reject|rejects|hold|retry|retries|configuration|setup|dependency|depends\s+on)\b/i;

const INTERACTION_FALLBACK_HINTS =
  'setup configuration automatic result entry import export web service api middleware connection protocol interface compile transmit queue request return';

export function expandQueryForStructuralLookup(query: string): string {
  const q = query.trim();
  if (!q) return q;

  const lower = q.toLowerCase();
  const sectionRef = lower.match(/\b\d+\.\d+(?:\.\d+){0,3}\b/)?.[0] ?? null;
  const asksList = /\b(list|full list|codes?|test\s*codes?)\b/i.test(q);
  const asksSection = /\b(appendix|section)\b/i.test(q);

  if (!asksSection && !sectionRef) return q;

  const hints = new Set<string>();
  if (sectionRef) {
    hints.add(`appendix ${sectionRef}`);
    hints.add(`section ${sectionRef}`);
  }
  if (asksList) {
    hints.add('test codes');
    hints.add('microbiology test codes');
    hints.add('test type number');
  }
  hints.add('appendix');

  const hintText = Array.from(hints).join(' ');
  return `${q} ${hintText}`.trim();
}

export function isListPriorityQuery(query: string): boolean {
  return LIST_PRIORITY_REGEX.test(query);
}

export function isRulesPriorityQuery(query: string): boolean {
  return RULES_PRIORITY_REGEX.test(query);
}

export function isCanonicalPriorityQuery(query: string): boolean {
  return isCanonicalLookupQuery(query);
}

export function hasSectionOrListEvidence(
  candidates: ScoredChunk[],
  sectionRefs: string[],
): boolean {
  if (candidates.length === 0) return false;

  const refs = sectionRefs.map((ref) => ref.toLowerCase());

  return candidates.some((chunk) => {
    const corpus = [
      chunk.section_title ?? '',
      chunk.citation_label ?? '',
      chunk.content_preview ?? '',
      chunk.content ?? '',
    ].join('\n').toLowerCase();

    const hasSectionRef = refs.some((ref) => corpus.includes(ref));
    const hasListSignal = LIST_EVIDENCE_REGEX.test(corpus);
    return hasSectionRef || hasListSignal;
  });
}

function dedupeById(chunks: ScoredChunk[], scoreFn: (chunk: ScoredChunk) => number): ScoredChunk[] {
  const map = new Map<string, ScoredChunk>();

  for (const chunk of chunks) {
    const existing = map.get(chunk.id);
    if (!existing || scoreFn(chunk) > scoreFn(existing)) {
      map.set(chunk.id, chunk);
    }
  }

  return Array.from(map.values());
}

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
  return hybridSearchWithMode(query, 'standard');
}

type InteractionDepthMode = 'standard' | 'deep';

export interface RetrievalOptions {
  interaction?: {
    systemA?: string;
    systemB?: string;
    preferredDocumentIds?: string[];
    depthMode?: InteractionDepthMode;
    queryHintTerms?: string[];
  };
}

function entityMentioned(corpus: string, entity?: string): boolean {
  if (!entity?.trim()) return false;
  const escaped = entity.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(corpus);
}

// Tier classification for interaction results
type InteractionTier = 'tier1_both_entities' | 'tier2_integrated' | 'tier3_supporting';

interface ScoredInteractionChunk extends ScoredChunk {
  interactionTier: InteractionTier;
  hasBothEntities: boolean;
  hasIntegrationSignal: boolean;
  hasTransferVerb: boolean;
  hasSetupSignal: boolean;
}

function classifyInteractionTier(
  chunk: ScoredChunk,
  corpus: string,
  systemA?: string,
  systemB?: string,
): {
  tier: InteractionTier;
  hasBothEntities: boolean;
  hasIntegrationSignal: boolean;
  hasTransferVerb: boolean;
  hasSetupSignal: boolean;
} {
  const hasPair = Boolean(systemA?.trim() && systemB?.trim());
  const hasA = entityMentioned(corpus, systemA);
  const hasB = entityMentioned(corpus, systemB);
  const hasIntegration = INTERACTION_MECHANISM_REGEX.test(corpus);
  const hasTransfer = INTERACTION_TRANSFER_VERB_REGEX.test(corpus);
  const hasSetup = INTERACTION_SETUP_SECTION_REGEX.test(chunk.section_title ?? '');

  if (hasA && hasB) {
    return {
      tier: 'tier1_both_entities',
      hasBothEntities: true,
      hasIntegrationSignal: hasIntegration,
      hasTransferVerb: hasTransfer,
      hasSetupSignal: hasSetup,
    };
  }

  // If no explicit entity pair is available (pattern/generic interaction prompts),
  // allow mechanism-bearing chunks to rank as Tier 2.
  if (hasIntegration && (!hasPair || hasA || hasB)) {
    return {
      tier: 'tier2_integrated',
      hasBothEntities: false,
      hasIntegrationSignal: hasIntegration,
      hasTransferVerb: hasTransfer,
      hasSetupSignal: hasSetup,
    };
  }

  return {
    tier: 'tier3_supporting',
    hasBothEntities: false,
    hasIntegrationSignal: hasIntegration,
    hasTransferVerb: hasTransfer,
    hasSetupSignal: hasSetup,
  };
}

function computeTierScoreBonus(
  tier: InteractionTier,
  hasTransfer: boolean,
  hasSetup: boolean,
  baseScore: number,
): number {
  let boost = 1.0;

  if (tier === 'tier1_both_entities') {
    boost *= 1.4; // Strong relevance for dual-entity chunks
  } else if (tier === 'tier2_integrated') {
    boost *= 1.15; // Moderate boost for integrated signal
  }
  // tier3_supporting gets no boost

  if (hasTransfer) {
    boost *= 1.12; // Transfer verbs indicate active flow
  }

  if (hasSetup) {
    boost *= 1.08; // Setup/config sections are mechanism indicators
  }

  return baseScore * boost;
}

interface InteractionSelectionResult {
  selected: ScoredChunk[];
  diagnostics: {
    totalSources: number;
    tier1Count: number;
    tier2Count: number;
    tier3Count: number;
    uniqueDocCount: number;
    hasMechanismChunk: boolean;
    tierBalanceRatio: string;
  };
}

export { classifyInteractionTier, computeTierScoreBonus, mergeInteractionSelections, pickInteractionResults };
export type { InteractionSelectionResult };

function mergeInteractionSelections(
  primary: ScoredChunk[],
  secondary: ScoredChunk[],
  targetCount: number,
  hardCap: number,
  maxPerDocument: number,
  maxLowSignal: number,
  systemA?: string,
  systemB?: string,
): InteractionSelectionResult {
  const merged = dedupeById(
    [...primary, ...secondary],
    (chunk) => chunk.score,
  ).sort((a, b) => b.score - a.score);

  return pickInteractionResults(
    merged,
    targetCount,
    hardCap,
    maxPerDocument,
    maxLowSignal,
    systemA,
    systemB,
  );
}

function pickInteractionResults(
  ranked: ScoredChunk[],
  targetCount: number,
  hardCap: number,
  maxPerDocument: number,
  maxLowSignal: number,
  systemA?: string,
  systemB?: string,
): InteractionSelectionResult {
  const selectionLimit = Math.min(targetCount, hardCap);
  const selected: ScoredChunk[] = [];
  const perDocCount = new Map<string, number>();
  const uniqueDocs = new Set<string>();
  const selectedIds = new Set<string>();

  let tier1Count = 0;
  let tier2Count = 0;
  let tier3Count = 0;
  let lowSignalCount = 0;

  const classified: ScoredInteractionChunk[] = ranked.map((chunk) => {
    const corpus = `${chunk.section_title ?? ''} ${chunk.content_preview ?? ''} ${chunk.content ?? ''}`;
    const tierInfo = classifyInteractionTier(chunk, corpus, systemA, systemB);
    const tierScore = computeTierScoreBonus(
      tierInfo.tier,
      tierInfo.hasTransferVerb,
      tierInfo.hasSetupSignal,
      chunk.score,
    );

    return {
      ...chunk,
      score: tierScore,
      interactionTier: tierInfo.tier,
      hasBothEntities: tierInfo.hasBothEntities,
      hasIntegrationSignal: tierInfo.hasIntegrationSignal,
      hasTransferVerb: tierInfo.hasTransferVerb,
      hasSetupSignal: tierInfo.hasSetupSignal,
    };
  });

  const tierOrder: Record<InteractionTier, number> = {
    tier1_both_entities: 0,
    tier2_integrated: 1,
    tier3_supporting: 2,
  };

  classified.sort((a, b) => {
    const tierDiff = tierOrder[a.interactionTier] - tierOrder[b.interactionTier];
    if (tierDiff !== 0) return tierDiff;
    return b.score - a.score;
  });

  const take = (item: ScoredInteractionChunk): boolean => {
    if (selected.length >= selectionLimit) return false;
    if (selectedIds.has(item.id)) return false;

    const docCurrent = perDocCount.get(item.document_id) ?? 0;
    if (docCurrent >= maxPerDocument) return false;

    const isLowSignal = item.interactionTier === 'tier3_supporting';
    if (isLowSignal && lowSignalCount >= maxLowSignal) return false;

    // Keep interaction sets mechanism-forward: avoid overfilling Tier 3 when it would
    // drag Tier1+Tier2 below a healthy 60% share.
    if (isLowSignal) {
      const projectedTier12 = tier1Count + tier2Count;
      const projectedTotal = selected.length + 1;

      // If we have no Tier1/Tier2 yet, allow only one provisional Tier3 while we keep searching.
      if (projectedTier12 === 0 && tier3Count >= 1) return false;

      // Once Tier1/Tier2 exists, reject Tier3 additions that would drop below 60% Tier1+Tier2.
      if (projectedTier12 > 0 && projectedTier12 / projectedTotal < 0.6) return false;
    }

    selected.push(item);
    selectedIds.add(item.id);
    perDocCount.set(item.document_id, docCurrent + 1);
    uniqueDocs.add(item.document_id);

    if (item.interactionTier === 'tier1_both_entities') tier1Count += 1;
    else if (item.interactionTier === 'tier2_integrated') tier2Count += 1;
    else {
      tier3Count += 1;
      lowSignalCount += 1;
    }

    return true;
  };

  const tier1Candidates = classified.filter((item) => item.interactionTier === 'tier1_both_entities');
  for (const item of tier1Candidates.slice(0, 2)) {
    take(item);
  }

  const mechanismCandidate = classified.find(
    (item) => !selectedIds.has(item.id) && (item.hasIntegrationSignal || item.hasSetupSignal),
  );
  if (mechanismCandidate) {
    take(mechanismCandidate);
  }

  for (const item of classified) {
    if (selected.length >= selectionLimit) break;
    take(item);
  }

  // Hard requirement: enforce Tier 3 ceiling and mechanism presence
  if (tier3Count > maxLowSignal) {
    console.warn(
      `[interaction-warning] Tier 3 exceeds cap: ${tier3Count} > ${maxLowSignal}. This should not happen.`,
    );
  }

  const hasMechanismChunk =
    selected.some((chunk) => {
      const corpus = `${chunk.section_title ?? ''} ${chunk.content_preview ?? ''} ${chunk.content ?? ''}`;
      return INTERACTION_MECHANISM_REGEX.test(corpus);
    });

  return {
    selected,
    diagnostics: {
      totalSources: selected.length,
      tier1Count,
      tier2Count,
      tier3Count,
      uniqueDocCount: uniqueDocs.size,
      hasMechanismChunk,
      tierBalanceRatio: tier1Count + tier2Count > 0 ? ((tier1Count + tier2Count) / selected.length).toFixed(2) : '0.00',
    },
  };
}

interface SynthesisSelectionOptions {
  preserveAuthoritativeStructuredSource?: boolean;
}

export function pickSynthesisResults(
  ranked: ScoredChunk[],
  targetCount: number,
  maxPerDocument: number,
  options: SynthesisSelectionOptions = {},
): ScoredChunk[] {
  const selected: ScoredChunk[] = [];
  const perDocCount = new Map<string, number>();

  for (const chunk of ranked) {
    const current = perDocCount.get(chunk.document_id) ?? 0;
    if (current >= maxPerDocument) continue;

    selected.push(chunk);
    perDocCount.set(chunk.document_id, current + 1);
    if (selected.length >= targetCount) break;
  }

  const seen = new Set(selected.map((s) => s.id));
  for (const chunk of ranked) {
    if (selected.length >= targetCount) break;
    if (seen.has(chunk.id)) continue;
    selected.push(chunk);
  }

  if (!options.preserveAuthoritativeStructuredSource) {
    return selected;
  }

  const hasPreservedStructuredSource = selected.some(
    (chunk) => isStructuredSourceType(chunk.source_type) && isAuthoritativeChunkCandidate(chunk),
  );

  if (hasPreservedStructuredSource) {
    return selected;
  }

  const authoritativeStructuredCandidate = ranked.find(
    (chunk) =>
      !selected.some((selectedChunk) => selectedChunk.id === chunk.id) &&
      isStructuredSourceType(chunk.source_type) &&
      isAuthoritativeChunkCandidate(chunk),
  );

  if (!authoritativeStructuredCandidate) {
    return selected;
  }

  if (selected.length < targetCount) {
    return [...selected, authoritativeStructuredCandidate];
  }

  const replacementIndex = [...selected]
    .map((chunk, index) => ({ chunk, index }))
    .reverse()
    .find(({ chunk }) => !(isStructuredSourceType(chunk.source_type) && isAuthoritativeChunkCandidate(chunk)))?.index;

  if (replacementIndex == null) {
    return selected;
  }

  const replaced = [...selected];
  replaced[replacementIndex] = authoritativeStructuredCandidate;
  const rankIndex = new Map(ranked.map((chunk, index) => [chunk.id, index]));
  replaced.sort((a, b) => (rankIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rankIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER));

  return replaced;
}

export async function hybridSearchWithMode(
  query: string,
  mode: RetrievalMode = 'standard',
  options: RetrievalOptions = {},
): Promise<ScoredChunk[]> {
  const topK = parseInt(process.env.TOP_K_CANDIDATES || '25', 10);
  const topKFinal = parseInt(process.env.TOP_K_FINAL || '8', 10);
  const synthesisTopK = parseInt(process.env.SYNTHESIS_TOP_K_CANDIDATES || '35', 10);
  const synthesisTopKFinal = parseInt(process.env.SYNTHESIS_TOP_K_FINAL || '24', 10);
  const synthesisMaxPerDoc = parseInt(process.env.SYNTHESIS_MAX_PER_DOC || '2', 10);
  const canonicalTopK = parseInt(process.env.CANONICAL_TOP_K_CANDIDATES || '45', 10);
  const canonicalTopKFinal = parseInt(process.env.CANONICAL_TOP_K_FINAL || '24', 10);
  const canonicalMaxPerDoc = parseInt(process.env.CANONICAL_MAX_PER_DOC || '3', 10);
  // Interaction mode: wide candidate pool, tighter final set with tiered source selection.
  const interactionTopK = parseInt(process.env.INTERACTION_TOP_K_CANDIDATES || '40', 10);
  const interactionTopKFinal = parseInt(process.env.INTERACTION_TOP_K_FINAL || '18', 10);
  const interactionMaxPerDoc = parseInt(process.env.INTERACTION_MAX_PER_DOC || '3', 10);
  const interactionMaxLowSignal = parseInt(process.env.INTERACTION_MAX_LOW_SIGNAL || '2', 10);
  const interactionHardCap = parseInt(process.env.INTERACTION_HARD_CAP || '20', 10);

  const wVec = parseFloat(process.env.VECTOR_WEIGHT || '0.5');
  const wFts = parseFloat(process.env.FTS_WEIGHT || '0.3');
  const wTrgm = parseFloat(process.env.TRIGRAM_WEIGHT || '0.2');
  const downrankPenalty = parseFloat(process.env.DOWNRANK_PENALTY || '0.5');

  const prep = prepareQuery(query);
  const synthesisLike = mode === 'synthesis' || mode === 'canonical';
  const interactionMode = mode === 'interaction';
  const interactionPair = interactionMode
    ? {
      systemA: options.interaction?.systemA ?? extractInteractionEntityPair(query)?.systemA,
      systemB: options.interaction?.systemB ?? extractInteractionEntityPair(query)?.systemB,
    }
    : undefined;
  const preferredDocIds = new Set(options.interaction?.preferredDocumentIds ?? []);
  const depthMode = options.interaction?.depthMode ?? 'standard';
  const useStructuralExpansion = mode === 'structural' || synthesisLike;
  const needsRulesPriority = synthesisLike && isRulesPriorityQuery(query);
  const needsCanonicalPriority = synthesisLike && isCanonicalPriorityQuery(query);
  const needsCataloguePriority = synthesisLike && isCatalogueStyleQuery(query);
  const rulesBiasHints =
    'must shall required if when only if enter reject accept notify adjust release confirm limit threshold range code result code criteria condition validation';
  const canonicalBiasHints =
    'canonical master authoritative reference table lookup list code mapping register matrix appendix';
  const interactionBiasHints =
    'integration interface web service automatic entry import export setup configuration middleware connection protocol trigger flow exchange sorter robot analyser instrument result entry';
  const baseSearchQuery = buildRegistryQueryExpansion(useStructuralExpansion && prep.isStructural ? prep.expanded : query);
  const interactionPairHints = interactionPair?.systemA && interactionPair?.systemB
    ? `${interactionPair.systemA} ${interactionPair.systemB}`
    : '';
  const interactionDeepHints = interactionMode
    ? (options.interaction?.queryHintTerms ?? []).join(' ').trim()
    : '';

  const searchQuery = [
    baseSearchQuery,
    needsRulesPriority ? rulesBiasHints : '',
    needsCanonicalPriority ? canonicalBiasHints : '',
    interactionMode ? interactionBiasHints : '',
    interactionMode ? interactionPairHints : '',
    interactionMode ? interactionDeepHints : '',
  ].filter(Boolean).join(' ').trim();
  const lexicalLimit = mode === 'canonical' ? canonicalTopK
    : mode === 'synthesis' ? synthesisTopK
    : mode === 'interaction' ? interactionTopK
    : topK;
  const sectionAnchorLimit = synthesisLike ? 26 : 20;
  const listAnchorLimit = synthesisLike ? 24 : 12;
  const authoritativeAnchorLimit = mode === 'canonical' ? 30 : synthesisLike ? 22 : 0;
  const needsListPriority = synthesisLike && (isListPriorityQuery(query) || needsCataloguePriority);
  const shouldPrioritizeStructuredSources = synthesisLike && (needsListPriority || needsCanonicalPriority || needsRulesPriority);

  // Embed query — fall back to empty vector results if LM Studio is unavailable
  let queryEmbedding: number[] | null = null;
  try {
    queryEmbedding = await embedText(query);
  } catch {
    console.warn('[retrieval] embedText failed — falling back to text-only search (FTS + trigram)');
  }

  const [vecResults, ftsResults, trgResults, sectionAnchors, listAnchors, authoritativeAnchors] = await Promise.all([
    queryEmbedding ? vectorSearch(queryEmbedding, lexicalLimit) : Promise.resolve([]),
    fullTextSearch(searchQuery, lexicalLimit, prep.sectionRefs, prep.documentRefs),
    trigramSearch(searchQuery, lexicalLimit, prep.sectionRefs, prep.documentRefs),
    prep.sectionRefs.length > 0
      ? findChunksBySectionRefs(prep.sectionRefs, sectionAnchorLimit)
      : Promise.resolve([]),
    needsListPriority
      ? findListPriorityChunks(listAnchorLimit)
      : Promise.resolve([]),
    synthesisLike
      ? findAuthoritativeChunks(searchQuery, authoritativeAnchorLimit, prep.sectionRefs)
      : Promise.resolve([]),
  ]);

  // Inject canonical appendix/list chunks before ranking/trimming.
  const ftsCandidates = dedupeById(
    [...ftsResults, ...sectionAnchors, ...listAnchors, ...authoritativeAnchors],
    (chunk) => chunk.fts_score ?? chunk.score,
  );
  const trgCandidates = dedupeById(
    [...trgResults, ...sectionAnchors, ...listAnchors, ...authoritativeAnchors],
    (chunk) => chunk.trigram_score ?? chunk.score,
  );

  if (prep.sectionRefs.length > 0) {
    const hasEvidence = hasSectionOrListEvidence(
      dedupeById([...vecResults, ...ftsCandidates, ...trgCandidates], (chunk) => chunk.score),
      prep.sectionRefs,
    );
    if (!hasEvidence) {
      console.warn(
        `[retrieval-miss] section refs (${prep.sectionRefs.join(', ')}) not found in candidate pool for query: ${query}`,
      );
    }
  }

  // Normalize each result set
  const vecNorm = minMaxNormalize(vecResults.map((r) => r.vector_score ?? r.score));
  const ftsNorm = minMaxNormalize(ftsCandidates.map((r) => r.fts_score ?? r.score));
  const trgNorm = minMaxNormalize(trgCandidates.map((r) => r.trigram_score ?? r.score));

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
    entry._vecNorm = Math.max(entry._vecNorm, vecNorm[i]);
  });

  ftsCandidates.forEach((chunk, i) => {
    const entry = ensureEntry(chunk);
    entry._ftsNorm = Math.max(entry._ftsNorm, ftsNorm[i]);
  });

  trgCandidates.forEach((chunk, i) => {
    const entry = ensureEntry(chunk);
    entry._trgNorm = Math.max(entry._trgNorm, trgNorm[i]);
  });

  // Compute fusion score and populate final fields
  const results: ScoredChunk[] = [];
  for (const entry of merged.values()) {
    let fusionScore =
      wVec * entry._vecNorm + wFts * entry._ftsNorm + wTrgm * entry._trgNorm;

    // Slightly bias rules synthesis queries toward explicit rule-like language.
    if (needsRulesPriority) {
      const corpus = `${entry.section_title ?? ''} ${entry.content_preview ?? ''} ${entry.content ?? ''}`;
      if (RULE_SIGNAL_REGEX.test(corpus) || hasRuleSignal(corpus)) {
        fusionScore *= 1.08;
      }
    }

    // Prefer structured catalogue/reference sources for list/canonical/rules synthesis tasks.
    if (shouldPrioritizeStructuredSources && isStructuredSourceType(entry.source_type)) {
      fusionScore *= 1.12;
    }

    // Interaction mode: boost chunks mentioning integration/interface/data-flow content.
    if (interactionMode) {
      const corpus = `${entry.section_title ?? ''} ${entry.content_preview ?? ''} ${entry.content ?? ''}`;
      if (INTERACTION_MECHANISM_REGEX.test(corpus)) {
        fusionScore *= 1.15;
      }
      if (INTERACTION_SETUP_SECTION_REGEX.test(entry.section_title ?? '')) {
        fusionScore *= 1.08;
      }
      if (INTERACTION_TRANSFER_VERB_REGEX.test(corpus)) {
        fusionScore *= 1.12;
      }
      if (INTERACTION_DEPENDENCY_REGEX.test(corpus)) {
        fusionScore *= 1.1;
      }

      const hasA = entityMentioned(corpus, interactionPair?.systemA);
      const hasB = entityMentioned(corpus, interactionPair?.systemB);

      // Strong relevance boost when both interaction entities are present.
      if (hasA && hasB) {
        fusionScore *= 1.4;
      }

      // Penalize single-side mentions that lack actual integration signal.
      if ((hasA !== hasB) && !INTERACTION_MECHANISM_REGEX.test(corpus)) {
        fusionScore *= 0.7;
      }

      if (preferredDocIds.has(entry.document_id)) {
        fusionScore *= 1.1;
      }
    }

    fusionScore *= getRegistrySourceBoost(query, entry);

    // Apply downrank penalty for chunks flagged as low-quality but not excluded
    if (entry.retrieval_downranked) {
      fusionScore *= downrankPenalty;
    }

    results.push({
      id: entry.id,
      document_id: entry.document_id,
      source_type: entry.source_type,
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
      retrieval_downranked: entry.retrieval_downranked,
    });
  }

  // Sort descending by fusion score
  results.sort((a, b) => b.score - a.score);

  if (mode === 'canonical') {
    return pickSynthesisResults(results, canonicalTopKFinal, canonicalMaxPerDoc, {
      preserveAuthoritativeStructuredSource: true,
    });
  }

  if (mode === 'synthesis') {
    return pickSynthesisResults(results, synthesisTopKFinal, synthesisMaxPerDoc, {
      preserveAuthoritativeStructuredSource: needsCanonicalPriority || needsListPriority,
    });
  }

  if (mode === 'interaction') {
    const interactionCap = Math.min(interactionTopKFinal + (depthMode === 'deep' ? 2 : 0), interactionHardCap);
    const result = pickInteractionResults(
      results,
      interactionCap,
      interactionHardCap,
      interactionMaxPerDoc,
      interactionMaxLowSignal,
      interactionPair?.systemA,
      interactionPair?.systemB,
    );

    console.log(
      `[interaction-retrieval] tier distribution: Tier1=${result.diagnostics.tier1Count}, Tier2=${result.diagnostics.tier2Count}, Tier3=${result.diagnostics.tier3Count}, total=${result.diagnostics.totalSources}, docs=${result.diagnostics.uniqueDocCount}, mechanism=${result.diagnostics.hasMechanismChunk}`,
    );

    // Hard requirement: if primary retrieval has results but no mechanism chunk, trigger mechanism-focused fallback
    if (result.selected.length > 0 && !result.diagnostics.hasMechanismChunk) {
      console.log(
        `[interaction-retrieval-mechanism-fallback] No mechanism chunk in primary results. Triggering mechanism-focused fallback.`,
      );

      const mechanismFallbackHints = [
        'integration mechanism',
        'interface',
        'web service',
        'api',
        'automatic entry',
        'middleware',
        'connection',
        'protocol',
        'data flow',
        'exchange',
        'trigger',
        'setup',
        'configuration',
      ]
        .join(' ');
      const mechanismFallbackQuery = `${interactionPair?.systemA ?? ''} ${interactionPair?.systemB ?? ''} ${mechanismFallbackHints}`.trim();

      const mechanismFallback = await hybridSearchWithMode(mechanismFallbackQuery, 'synthesis');
      const mechanismResult = pickInteractionResults(
        mechanismFallback,
        Math.ceil(interactionCap / 2),
        interactionHardCap,
        interactionMaxPerDoc,
        interactionMaxLowSignal,
        interactionPair?.systemA,
        interactionPair?.systemB,
      );

      if (mechanismResult.diagnostics.hasMechanismChunk && mechanismResult.selected.length > 0) {
        const finalResult = mergeInteractionSelections(
          result.selected,
          mechanismResult.selected,
          interactionCap,
          interactionHardCap,
          interactionMaxPerDoc,
          interactionMaxLowSignal,
          interactionPair?.systemA,
          interactionPair?.systemB,
        );
        console.log(
          `[interaction-retrieval-mechanism-fallback-result] merged: Tier1=${finalResult.diagnostics.tier1Count}, Tier2=${finalResult.diagnostics.tier2Count}, mechanism=${finalResult.diagnostics.hasMechanismChunk}`,
        );
        return finalResult.selected;
      }
    }

    if (result.selected.length > 0) {
      return result.selected;
    }

    // Fallback path for interaction queries with no usable results:
    // search each side independently and merge into a synthesis-ready pool.
    const fallbackQueries = [
      interactionPair?.systemA,
      interactionPair?.systemB,
      interactionPair?.systemA && interactionPair?.systemB
        ? `${interactionPair.systemA} ${interactionPair.systemB}`
        : '',
    ]
      .filter((value): value is string => Boolean(value?.trim()))
      .map((value) => `${value} ${INTERACTION_FALLBACK_HINTS}`.trim());

    if (fallbackQueries.length === 0) {
      return [];
    }

    const fallbackBuckets = await Promise.all(
      fallbackQueries.map((fallbackQuery) => hybridSearchWithMode(fallbackQuery, 'synthesis')),
    );

    const mergedFallback = dedupeById(
      fallbackBuckets.flat(),
      (chunk) => chunk.score,
    ).sort((a, b) => b.score - a.score);

    const fallbackResult = pickInteractionResults(
      mergedFallback,
      interactionCap,
      interactionHardCap,
      interactionMaxPerDoc,
      interactionMaxLowSignal,
      interactionPair?.systemA,
      interactionPair?.systemB,
    );

    console.log(
      `[interaction-retrieval-fallback] tier distribution: Tier1=${fallbackResult.diagnostics.tier1Count}, Tier2=${fallbackResult.diagnostics.tier2Count}, Tier3=${fallbackResult.diagnostics.tier3Count}, total=${fallbackResult.diagnostics.totalSources}, docs=${fallbackResult.diagnostics.uniqueDocCount}`,
    );

    return fallbackResult.selected;
  }

  return results.slice(0, topKFinal);
}
