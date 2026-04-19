const INTERACTION_CONTEXT_MARKER = 'INTERACTION_CONTEXT:';

const FOLLOWUP_VAGUE_REGEX =
  /^\s*(more\s+detail|expand\s+(on\s+this|that|it)|go\s+deeper|explain\s+(the|this|that|more)|what\s+(are|is)\s+the\s+failure\s+(points?|modes?)|what\s+decides?|where\s+is\s+the\s+source\s+of\s+truth|how\s+does\s+(that|it)\s+work|what\s+happens?\s+if|and\s+then\s+what|what\s+next)\b/i;

const DEEP_INTERACTION_REGEX =
  /\b(more\s+detail|go\s+deeper|deep\s+dive|failure\s+(points?|modes?)|what\s+happens?\s+if|where\s+is\s+the\s+logic|source\s+of\s+truth|dependency|dependencies|edge\s+cases?|manual\s+path|fallback)\b/i;

type ChatMessage = { role: 'user' | 'assistant'; content: string };

export type InteractionContext = {
  systemA?: string;
  systemB?: string;
  lastIntent: 'interaction_explanation';
  retrievedDocIds: string[];
  hintTerms?: string[];
};

export function isVagueInteractionFollowUp(question: string): boolean {
  return FOLLOWUP_VAGUE_REGEX.test(question);
}

export function isDeepInteractionFollowUp(question: string): boolean {
  return DEEP_INTERACTION_REGEX.test(question);
}

export function parseInteractionContextFromText(text?: string): InteractionContext | undefined {
  if (!text) return undefined;
  const markerIndex = text.lastIndexOf(INTERACTION_CONTEXT_MARKER);
  if (markerIndex < 0) return undefined;

  const tail = text.slice(markerIndex + INTERACTION_CONTEXT_MARKER.length);
  const endMarker = tail.indexOf('-->');
  const raw = (endMarker >= 0 ? tail.slice(0, endMarker) : tail).trim();
  if (!raw) return undefined;

  try {
    const parsed = JSON.parse(raw) as InteractionContext;
    if (parsed?.lastIntent !== 'interaction_explanation') return undefined;
    return {
      systemA: parsed.systemA,
      systemB: parsed.systemB,
      lastIntent: 'interaction_explanation',
      retrievedDocIds: Array.isArray(parsed.retrievedDocIds) ? parsed.retrievedDocIds : [],
      hintTerms: Array.isArray(parsed.hintTerms)
        ? parsed.hintTerms.filter((term): term is string => typeof term === 'string' && term.trim().length > 0)
        : [],
    };
  } catch {
    return undefined;
  }
}

export function serializeInteractionContext(context: InteractionContext): string {
  return `\n\n<!-- ${INTERACTION_CONTEXT_MARKER}${JSON.stringify(context)} -->`;
}

function findLatestAssistantMessage(conversationHistory: ChatMessage[]): string | undefined {
  for (let i = conversationHistory.length - 1; i >= 0; i -= 1) {
    if (conversationHistory[i].role === 'assistant') {
      return conversationHistory[i].content;
    }
  }
  return undefined;
}

export function extractLatestInteractionContext(
  conversationHistory: ChatMessage[],
): InteractionContext | undefined {
  // Prefer explicit context marker from the latest assistant turns; skip malformed markers.
  for (let i = conversationHistory.length - 1; i >= 0; i -= 1) {
    if (conversationHistory[i].role !== 'assistant') continue;
    const parsed = parseInteractionContextFromText(conversationHistory[i].content);
    if (parsed) return parsed;
  }
  return undefined;
}

export function priorTurnWasInteraction(conversationHistory: ChatMessage[]): boolean {
  const lastAssistant = findLatestAssistantMessage(conversationHistory);
  if (!lastAssistant) return false;
  if (parseInteractionContextFromText(lastAssistant)) return true;

  return /\b(role of each|data flow|technical mechanism|direct integration|middleware-mediated|file-based exchange|manual operational linkage|source of truth|trigger|execution engine|decision engine)\b/i.test(
    lastAssistant,
  );
}

export function buildDeepInteractionHintTerms(
  question: string,
  context?: InteractionContext,
): string[] {
  const deepTerms: string[] = [];

  if (/fail|failure|fallback|manual/i.test(question)) {
    deepTerms.push('failure', 'fallback', 'manual path');
  }
  if (/logic|decide|decision/i.test(question)) {
    deepTerms.push('decision logic', 'routing logic');
  }
  if (/source of truth|truth/i.test(question)) {
    deepTerms.push('source of truth', 'authoritative record');
  }

  deepTerms.push('integration mechanism', 'data flow');

  for (const inherited of context?.hintTerms ?? []) {
    if (!deepTerms.includes(inherited)) deepTerms.push(inherited);
  }

  return deepTerms.slice(0, 8);
}

export function buildFollowUpRetrievalQuestion(
  question: string,
  context?: InteractionContext,
  hintTerms: string[] = [],
): string {
  const parts = [
    question,
    context?.systemA ?? '',
    context?.systemB ?? '',
    ...hintTerms,
  ]
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  return parts.join(' ');
}
