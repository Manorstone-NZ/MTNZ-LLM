import type { ModelTier } from './generation';
import type { QueryIntent } from './queryIntent';
import type { RetrievalMode } from './retrievalMode';

export type AnswerMode = 'lmstudio_only' | 'anthropic_only' | 'two_tier_auto';
export type ProviderUsed = 'lmstudio' | 'anthropic';

const COMPLEX_QUERY_REGEX =
  /\b(why|compare|contrast|explain|summari[sz]e|implications?|trade[-\s]?offs?|differences?|across\s+documents?|cross[-\s]?document|interaction|rules?)\b/i;

const KNOWN_ANSWER_MODES: AnswerMode[] = ['lmstudio_only', 'anthropic_only', 'two_tier_auto'];

export class RoutingDecisionError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'RoutingDecisionError';
  }
}

export interface RoutingChunkSignal {
  score: number;
  document_id: string;
}

export interface ResolveRoutingDecisionInput {
  configuredAnswerMode: AnswerMode;
  requestAnswerMode?: AnswerMode;
  requestLmStudioModel?: string;
  modelTier: ModelTier;
  question: string;
  bestScore: number;
  lowConfidenceThreshold: number;
  intent: QueryIntent;
  retrievalMode: RetrievalMode;
  chunks: RoutingChunkSignal[];
  anthropicAvailable: boolean;
  availableLmStudioModelIds?: string[];
  defaultLmStudioModel: string;
  qualityLmStudioModel: string;
  defaultAnthropicModel: string;
  qualityAnthropicModel: string;
}

export interface RoutingDecision {
  answer_mode_used: AnswerMode;
  provider_used: ProviderUsed;
  model_used: string;
  quality_mode_triggered: boolean;
  quality_mode_reason: string;
  request_override_applied: boolean;
}

export function parseAnswerMode(raw: string | undefined): AnswerMode | undefined {
  if (!raw) return undefined;
  return KNOWN_ANSWER_MODES.includes(raw as AnswerMode) ? (raw as AnswerMode) : undefined;
}

export function resolveConfiguredAnswerModeFromEnv(
  env: Record<string, string | undefined>,
): AnswerMode {
  return parseAnswerMode(env.ANSWER_MODE) ?? 'two_tier_auto';
}

function trimmedOrUndefined(value: string | undefined): string | undefined {
  if (value == null) return undefined;
  const out = value.trim();
  return out.length > 0 ? out : undefined;
}

function pickLmStudioModel(
  tier: ModelTier,
  explicitModel: string | undefined,
  defaultModel: string,
  qualityModel: string,
): string {
  return explicitModel ?? (tier === 'quality' ? qualityModel : defaultModel);
}

function pickAnthropicModel(
  tier: ModelTier,
  defaultModel: string,
  qualityModel: string,
): string {
  return tier === 'quality' ? qualityModel : defaultModel;
}

function hasMixedEvidence(chunks: RoutingChunkSignal[]): boolean {
  if (chunks.length < 3) return false;
  const uniqueDocs = new Set(chunks.map((chunk) => chunk.document_id));
  if (uniqueDocs.size < 2) return false;

  const sortedScores = chunks.map((chunk) => chunk.score).sort((a, b) => b - a);
  const topScore = sortedScores[0] ?? 0;
  const thirdScore = sortedScores[2] ?? topScore;
  return topScore - thirdScore < 0.08;
}

function getEscalationReasons(input: ResolveRoutingDecisionInput): string[] {
  const reasons: string[] = [];

  if (input.modelTier === 'quality') {
    reasons.push('quality_mode_requested');
  }
  if (input.bestScore < input.lowConfidenceThreshold) {
    reasons.push('low_grounded_score');
  }
  if (input.intent === 'synthesis_rules' || input.intent === 'synthesis_list' || input.intent === 'canonical_lookup') {
    reasons.push('synthesis_or_canonical_query');
  }
  if (input.retrievalMode === 'synthesis' || input.retrievalMode === 'canonical') {
    reasons.push('cross_document_synthesis');
  }
  if (COMPLEX_QUERY_REGEX.test(input.question)) {
    reasons.push('complex_query_pattern');
  }
  if (hasMixedEvidence(input.chunks)) {
    reasons.push('mixed_evidence');
  }

  return reasons;
}

function ensureLocalModelAvailable(model: string, availableModelIds?: string[]): void {
  if (!availableModelIds || availableModelIds.length === 0) {
    return;
  }
  if (availableModelIds.includes(model)) {
    return;
  }
  throw new RoutingDecisionError(
    'LMSTUDIO_MODEL_UNAVAILABLE',
    `Selected LM Studio model "${model}" is not currently available.`,
  );
}

export function resolveRoutingDecision(input: ResolveRoutingDecisionInput): RoutingDecision {
  const requestLmStudioModel = trimmedOrUndefined(input.requestLmStudioModel);
  const answerMode = input.requestAnswerMode ?? input.configuredAnswerMode;
  const requestOverrideApplied = input.requestAnswerMode != null;

  const lmStudioModel = pickLmStudioModel(
    input.modelTier,
    requestLmStudioModel,
    input.defaultLmStudioModel,
    input.qualityLmStudioModel,
  );

  const anthropicModel = pickAnthropicModel(
    input.modelTier,
    input.defaultAnthropicModel,
    input.qualityAnthropicModel,
  );

  if (answerMode === 'lmstudio_only') {
    ensureLocalModelAvailable(lmStudioModel, input.availableLmStudioModelIds);
    return {
      answer_mode_used: answerMode,
      provider_used: 'lmstudio',
      model_used: lmStudioModel,
      quality_mode_triggered: false,
      quality_mode_reason: 'none',
      request_override_applied: requestOverrideApplied,
    };
  }

  if (answerMode === 'anthropic_only') {
    if (!input.anthropicAvailable) {
      throw new RoutingDecisionError(
        'ANTHROPIC_UNAVAILABLE',
        'Claude is unavailable. Set ANTHROPIC_API_KEY (or CLAUDE_API_KEY) and ensure ANTHROPIC_ENABLED/CLAUDE_ENABLED are not false.',
      );
    }
    return {
      answer_mode_used: answerMode,
      provider_used: 'anthropic',
      model_used: anthropicModel,
      quality_mode_triggered: input.modelTier === 'quality',
      quality_mode_reason: input.modelTier === 'quality' ? 'quality_mode_requested' : 'none',
      request_override_applied: requestOverrideApplied,
    };
  }

  const escalationReasons = getEscalationReasons(input);
  const shouldEscalate = escalationReasons.length > 0;

  if (shouldEscalate && input.anthropicAvailable) {
    return {
      answer_mode_used: answerMode,
      provider_used: 'anthropic',
      model_used: anthropicModel,
      quality_mode_triggered: true,
      quality_mode_reason: escalationReasons.join(','),
      request_override_applied: requestOverrideApplied,
    };
  }

  if (shouldEscalate && !input.anthropicAvailable) {
    ensureLocalModelAvailable(lmStudioModel, input.availableLmStudioModelIds);
    return {
      answer_mode_used: answerMode,
      provider_used: 'lmstudio',
      model_used: lmStudioModel,
      quality_mode_triggered: true,
      quality_mode_reason: [...escalationReasons, 'anthropic_unavailable_fallback_local'].join(','),
      request_override_applied: requestOverrideApplied,
    };
  }

  ensureLocalModelAvailable(lmStudioModel, input.availableLmStudioModelIds);
  return {
    answer_mode_used: answerMode,
    provider_used: 'lmstudio',
    model_used: lmStudioModel,
    quality_mode_triggered: false,
    quality_mode_reason: 'none',
    request_override_applied: requestOverrideApplied,
  };
}
