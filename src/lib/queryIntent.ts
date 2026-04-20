import {
  isCanonicalLookupQuery,
  isCatalogueStyleQuery,
  isMappingStyleQuery,
  isRulesStyleQuery,
} from './authoritativeSources';
import { extractRegistryInteractionPair } from './entityRegistry';

export type QueryIntent =
  | 'standard'
  | 'structural'
  | 'synthesis_list'
  | 'synthesis_rules'
  | 'canonical_lookup'
  | 'interaction_explanation';

export interface QueryIntentResult {
  intent: QueryIntent;
  sectionRefs: string[];
  signals: string[];
}

export interface InteractionEntityPair {
  systemA: string;
  systemB: string;
}

const SECTION_REGEX = /\b\d+(?:\.\d+)+\b/g;
const STRUCTURAL_REGEX = /\b(appendix|section|table|schedule|annex)\b/i;
const WHAT_EXISTS_REGEX = /\bwhat\b.*\b(are there|exist|exists|supported|tests?|types?|codes?|programmes?|programs?|forms?|mappings?|registers?)\b/i;

// Matches questions about how two systems/components interact.
// Requires both an interaction verb AND two identifiable entities (at least 2 words).
const INTERACTION_VERB_REGEX =
  /\b(interact(?:s|ion)?\s+with|connect(?:s|ion)?\s+to|integrat(?:e|es|ion)\s+with|integration\s+between|send(?:s)?\s+data\s+to|work(?:s)?\s+with|flow(?:s)?\s+(?:between|from|to)|data\s+flow\s+from|how\s+do(?:es)?\s+(?:results?|data|messages?)\s+get\s+(?:from|to|into)|relationship\s+between|communication\s+between|interface\s+(?:between|with)|decision\s+logic\s+between|fallback\s+(?:path|manual\s+path)|what\s+happens\s+if.*fails?|fail(?:ure|s)?\s+(?:between|in)|which\s+integrations?\s+use|automatic\s+result\s+entry|operational\s+boundary|end\s+up\s+in\s+reports?|downstream\s+(?:billing|reporting|business\s+systems?|consumers?)|how\s+(?:does|do|is|are).*(?:interact|connect|integrate|communicate|talk\s+to|link(?:ed)?\s+to|feed(?:s)?\s+into|trigger|exchange|fail|fallback|prepare|propagate|transmit))\b/i;

const INTERACTION_ENTITY_PAIR_REGEX =
  /\b[A-Za-z][A-Za-z0-9_-]+\b.*\b(?:and|with|to|between|from)\b.*\b[A-Za-z][A-Za-z0-9_-]+\b/i;

const NON_INTERACTION_QUERY_REGEX =
  /^\s*(define\b|list\b|show\b|show\s+me\b|what\s+tests?\b|what\s+test\s+types?\b|what\s+codes?\b|what\s+is\s+(?!the\s+(?:data\s+flow|fallback|manual\s+path|failure\s+path|operational\s+boundary|relationship|interface|integration)\b))/i;

const INTERACTION_PATTERN_QUERY_REGEX =
  /\b(which\s+integrations?\s+use|web\s*service|api\s+mechanism|file[-\s]*based\s+exchange|manual\s+override|event[-\s]*driven|automatic\s+result\s+entry|result\s+exports?|downstream\s+reporting|downstream\s+billing|operational\s+boundary|data\s+flow|analytics?\s+platforms?|business\s+systems?|prepared\s+for\s+downstream|end\s+up\s+in\s+reports?|fallback\s+manual\s+path)\b/i;

const SYSTEM_ALIASES: Array<{ regex: RegExp; canonical: string }> = [
  { regex: /\bmadcap\b/i, canonical: 'MADCAP' },
  { regex: /\bcombifoss\b/i, canonical: 'CombiFoss' },
  { regex: /\bbactoscan\b/i, canonical: 'BactoScan' },
  { regex: /\bcolony\s+counter\b/i, canonical: 'Colony Counter' },
  { regex: /\btitan\b/i, canonical: 'TITAN' },
  { regex: /\bods\b/i, canonical: 'ODS' },
  { regex: /\bqlik\b/i, canonical: 'Qlik' },
  { regex: /\bsap\s*b1\b|\bsap\s+business\s+one\b/i, canonical: 'SAP B1' },
  { regex: /\bsap\b/i, canonical: 'SAP' },
  { regex: /\bwso2\b/i, canonical: 'WSO2' },
  { regex: /\banalyser\b|\banalyzer\b/i, canonical: 'Analyser' },
  { regex: /\bsorter\b|\bsorting\s+robot\b/i, canonical: 'Sorter' },
  { regex: /\binstrument\b/i, canonical: 'Instrument' },
  { regex: /\breport(?:ing|s)?\b/i, canonical: 'Reporting' },
];

function titleCaseEntity(value: string): string {
  return value
    .trim()
    .replace(/^the\s+/i, '')
    .replace(/\s+/g, ' ')
    .split(' ')
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1).toLowerCase())
    .join(' ');
}

function normalizeEntity(entity: string): string {
  const raw = entity.trim();
  const alias = SYSTEM_ALIASES.find((entry) => entry.regex.test(raw));
  if (alias) return alias.canonical;
  return titleCaseEntity(raw);
}

export function extractInteractionEntityPair(input: string): InteractionEntityPair | undefined {
  const q = input.trim();
  if (!q) return undefined;

  const registryPair = extractRegistryInteractionPair(q);
  if (registryPair) {
    return registryPair;
  }

  const foundAliases = SYSTEM_ALIASES
    .map((entry) => {
      const match = q.match(entry.regex);
      if (!match || match.index == null) return null;
      return {
        canonical: entry.canonical,
        index: match.index,
      };
    })
    .filter((item): item is { canonical: string; index: number } => Boolean(item))
    .sort((a, b) => a.index - b.index);

  const uniqueAliases: string[] = [];
  for (const item of foundAliases) {
    if (!uniqueAliases.includes(item.canonical)) uniqueAliases.push(item.canonical);
  }

  if (uniqueAliases.length >= 2) {
    return {
      systemA: uniqueAliases[0],
      systemB: uniqueAliases[1],
    };
  }

  const pairMatch = q.match(/\b(?:between|from)\s+([A-Za-z][A-Za-z0-9\s_-]{1,40}?)\s+(?:and|to|into)\s+([A-Za-z][A-Za-z0-9\s_-]{1,40}?)(?:\?|$)/i)
    ?? q.match(/\b([A-Za-z][A-Za-z0-9\s_-]{1,40}?)\s+(?:with|and|to|into)\s+([A-Za-z][A-Za-z0-9\s_-]{1,40}?)(?:\?|$)/i);

  if (!pairMatch) return undefined;

  const left = normalizeEntity(pairMatch[1]);
  const right = normalizeEntity(pairMatch[2]);
  if (!left || !right || left.toLowerCase() === right.toLowerCase()) return undefined;

  return {
    systemA: left,
    systemB: right,
  };
}

export function classifyQueryIntent(input: string): QueryIntentResult {
  const q = input.trim();
  const sectionRefs = q.match(SECTION_REGEX) ?? [];

  const hasStructuralWord = STRUCTURAL_REGEX.test(q);
  const hasListLanguage = isCatalogueStyleQuery(q);
  const hasCanonicalLanguage = isCanonicalLookupQuery(q);
  const hasMappingLanguage = isMappingStyleQuery(q);
  const hasWhatExistsPattern = WHAT_EXISTS_REGEX.test(q);
  const hasRulesLanguage = isRulesStyleQuery(q);
  const hasInteractionVerb = INTERACTION_VERB_REGEX.test(q);
  const hasEntityPair = INTERACTION_ENTITY_PAIR_REGEX.test(q);
  const extractedInteractionPair = extractInteractionEntityPair(q);
  const hasNegativeInteractionPattern = NON_INTERACTION_QUERY_REGEX.test(q);
  const hasInteractionPatternQuery = INTERACTION_PATTERN_QUERY_REGEX.test(q);
  const isInteractionQuery =
    !hasNegativeInteractionPattern
    && (hasInteractionPatternQuery || (hasInteractionVerb
    && (hasEntityPair || Boolean(extractedInteractionPair) || hasInteractionPatternQuery)));

  const signals: string[] = [];
  if (hasStructuralWord) signals.push('structural_word');
  if (sectionRefs.length > 0) signals.push('section_ref');
  if (hasListLanguage) signals.push('list_language');
  if (hasCanonicalLanguage) signals.push('canonical_language');
  if (hasMappingLanguage) signals.push('mapping_language');
  if (hasWhatExistsPattern) signals.push('what_exists_pattern');
  if (hasRulesLanguage) signals.push('rules_query');
  if (hasInteractionPatternQuery) signals.push('interaction_pattern_query');
  if (isInteractionQuery) signals.push('interaction_query');
  if (hasNegativeInteractionPattern) signals.push('non_interaction_pattern');

  // Interaction queries take priority before structural/list/canonical so they get
  // the dedicated synthesis mode, not just fragment extraction.
  if (isInteractionQuery && !hasCanonicalLanguage && !hasListLanguage) {
    return {
      intent: 'interaction_explanation',
      sectionRefs,
      signals,
    };
  }

  if (hasMappingLanguage || (hasCanonicalLanguage && (hasListLanguage || sectionRefs.length > 0 || hasStructuralWord || hasWhatExistsPattern))) {
    return {
      intent: 'canonical_lookup',
      sectionRefs,
      signals,
    };
  }

  // Keep exact section-focused questions structural unless they also explicitly ask for rules or list synthesis.
  const isSectionFocused = sectionRefs.length > 0 && hasStructuralWord && !hasListLanguage && !hasWhatExistsPattern;
  if (isSectionFocused && hasRulesLanguage) {
    return {
      intent: 'synthesis_rules',
      sectionRefs,
      signals,
    };
  }

  const synthesisSignals = hasListLanguage || hasWhatExistsPattern;

  if (synthesisSignals) {
    return {
      intent: 'synthesis_list',
      sectionRefs,
      signals,
    };
  }

  if (hasRulesLanguage) {
    return {
      intent: 'synthesis_rules',
      sectionRefs,
      signals,
    };
  }

  if (hasStructuralWord || sectionRefs.length > 0) {
    return {
      intent: 'structural',
      sectionRefs,
      signals,
    };
  }

  return {
    intent: 'standard',
    sectionRefs: [],
    signals,
  };
}
