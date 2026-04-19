import type { QueryIntent } from './queryIntent';

export type RetrievalMode = 'standard' | 'structural' | 'synthesis' | 'canonical' | 'interaction';

export function retrievalModeFromIntent(intent: QueryIntent): RetrievalMode {
  if (intent === 'canonical_lookup') return 'canonical';
  if (intent === 'synthesis_list') return 'synthesis';
  if (intent === 'synthesis_rules') return 'synthesis';
  if (intent === 'structural') return 'structural';
  if (intent === 'interaction_explanation') return 'interaction';
  return 'standard';
}
