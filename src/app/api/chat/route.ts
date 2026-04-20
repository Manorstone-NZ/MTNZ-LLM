import { NextRequest } from 'next/server';
import { hybridSearchWithMode } from '@/lib/retrieval';
import {
  formatChunksForPrompt,
  formatChunksWithContent,
  normalizeAnswerWithReferences,
} from '@/lib/citations';
import {
  SYSTEM_PROMPT,
  SYNTHESIS_SYSTEM_PROMPT,
  SYNTHESIS_CANONICAL_PROMPT,
  SYNTHESIS_RULES_PROMPT,
  INTERACTION_EXPLANATION_PROMPT,
  buildSynthesisEvidencePolicyHint,
  buildAnswerMessage,
  buildSynthesisAnswerMessage,
  buildInteractionAnswerMessage,
  LOW_CONFIDENCE_CAVEAT,
  NO_EVIDENCE_MESSAGE,
} from '@/lib/prompts';
import { summariseRuleEvidence } from '@/lib/evidenceSummary';
import { classifyQueryIntent, extractInteractionEntityPair } from '@/lib/queryIntent';
import { retrievalModeFromIntent } from '@/lib/retrievalMode';
import { buildSynthesisContext } from '@/lib/synthesis';
import { generateStream } from '@/lib/generation';
import { listLmStudioModels } from '@/lib/generation';
import { isAnthropicProviderAvailableFromEnv } from '@/lib/generation';
import { embedText } from '@/lib/embeddings';
import type { ModelTier } from '@/lib/generation';
import type { ModelProviderMode } from '@/lib/generation';
import {
  parseAnswerMode,
  resolveConfiguredAnswerModeFromEnv,
  resolveRoutingDecision,
  RoutingDecisionError,
  type AnswerMode,
} from '@/lib/answerRouting';
import { buildAnswerStylePolicy, resolveAnswerStyle, type AnswerStyle } from '@/lib/answerPolicy';
import type { RetrievalOptions } from '@/lib/retrieval';
import { buildInteractionOperatingFrame, formatInteractionOperatingFrame } from '@/lib/interactionFrame';
import {
  buildDeepInteractionHintTerms,
  buildFollowUpRetrievalQuestion,
  extractLatestInteractionContext,
  isDeepInteractionFollowUp,
  isVagueInteractionFollowUp,
  priorTurnWasInteraction,
  serializeInteractionContext,
  type InteractionContext,
} from '@/lib/interactionContext';

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function answerModeFromLegacyProvider(provider?: ModelProviderMode): AnswerMode | undefined {
  if (!provider) return undefined;
  if (provider === 'lmstudio') return 'lmstudio_only';
  if (provider === 'anthropic') return 'anthropic_only';
  return 'two_tier_auto';
}

function extractLatestAssistantMessage(
  conversationHistory: { role: 'user' | 'assistant'; content: string }[],
): string | undefined {
  for (let i = conversationHistory.length - 1; i >= 0; i -= 1) {
    if (conversationHistory[i].role === 'assistant') {
      return conversationHistory[i].content;
    }
  }
  return undefined;
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const {
    question,
    conversationHistory = [],
    modelTier = 'default',
    modelProvider,
    answerStyle,
    answerMode,
    lmStudioModel,
  } = body as {
    question?: string;
    conversationHistory?: { role: 'user' | 'assistant'; content: string }[];
    modelTier?: ModelTier;
    modelProvider?: ModelProviderMode;
    answerStyle?: AnswerStyle;
    answerMode?: string;
    lmStudioModel?: string;
  };

  if (!question || typeof question !== 'string' || question.trim().length === 0) {
    return Response.json(
      { error: 'question is required and must be a non-empty string' },
      { status: 400 }
    );
  }

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const push = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(sseEvent(event, data)));
      };

      try {
        // Step 1: Determine answer mode early so we can skip LM Studio checks when not needed
        const earlyConfiguredMode = resolveConfiguredAnswerModeFromEnv(process.env);
        const earlyRequestMode = parseAnswerMode(answerMode) ?? answerModeFromLegacyProvider(modelProvider);
        const earlyEffectiveMode = earlyRequestMode ?? earlyConfiguredMode;
        const requiresLmStudio = earlyEffectiveMode !== 'anthropic_only';

        // Test LM Studio connectivity only when it may be used
        if (requiresLmStudio) {
          try {
            await embedText(question);
          } catch {
            if (earlyEffectiveMode === 'lmstudio_only') {
              push('error', { message: 'LM Studio is unavailable', code: 'LM_UNAVAILABLE' });
              controller.close();
              return;
            }
            // two_tier_auto: continue — routing will fall back to Anthropic if available
          }
        }

        // Step 2: Query intent and retrieval mode
        // If the question is a vague follow-up to a prior interaction answer, inherit interaction mode.
        const intentResult = classifyQueryIntent(question);
        const isVagueFollowUp = isVagueInteractionFollowUp(question);
        const priorContextText = extractLatestAssistantMessage(conversationHistory);
        const priorInteractionContext = extractLatestInteractionContext(conversationHistory);
        const inheritInteractionMode =
          isVagueFollowUp &&
          (priorTurnWasInteraction(conversationHistory) || Boolean(priorInteractionContext));
        const effectiveIntent = inheritInteractionMode ? 'interaction_explanation' : intentResult.intent;
        const retrievalMode = retrievalModeFromIntent(effectiveIntent);

        const isDeepFollowUp = isDeepInteractionFollowUp(question) && inheritInteractionMode;
        const extractedPair = extractInteractionEntityPair(question);
        const deepHintTerms =
          retrievalMode === 'interaction' && isDeepFollowUp
            ? buildDeepInteractionHintTerms(question, priorInteractionContext)
            : [];
        const interactionOptions: RetrievalOptions = retrievalMode === 'interaction'
          ? {
            interaction: {
              systemA: extractedPair?.systemA ?? priorInteractionContext?.systemA,
              systemB: extractedPair?.systemB ?? priorInteractionContext?.systemB,
              preferredDocumentIds: inheritInteractionMode ? priorInteractionContext?.retrievedDocIds : undefined,
              depthMode: isDeepFollowUp ? 'deep' : 'standard',
              queryHintTerms: deepHintTerms,
            },
          }
          : {};

        const retrievalQuestion =
          retrievalMode === 'interaction' && inheritInteractionMode
            ? buildFollowUpRetrievalQuestion(question, priorInteractionContext, deepHintTerms)
            : question;
        const effectiveAnswerStyle = resolveAnswerStyle(answerStyle, question);

        // Step 3: Hybrid search
        const chunks = await hybridSearchWithMode(retrievalQuestion, retrievalMode, interactionOptions);

        // Step 4: Thresholds
        const minGrounded = parseFloat(process.env.MIN_GROUNDED_SCORE ?? '0.18');
        const lowConfidence = parseFloat(process.env.LOW_CONFIDENCE_SCORE ?? '0.30');

        // Step 5: Check if we have usable results
        const bestScore = chunks.length > 0 ? Math.max(...chunks.map((c) => c.score)) : 0;

        const configuredAnswerMode = resolveConfiguredAnswerModeFromEnv(process.env);
        const requestAnswerMode = parseAnswerMode(answerMode) ?? answerModeFromLegacyProvider(modelProvider);
        const anthropicAvailable = isAnthropicProviderAvailableFromEnv(process.env);
        const effectiveAnswerMode = requestAnswerMode ?? configuredAnswerMode;
        let availableLmStudioModelIds: string[] | undefined;

        if (effectiveAnswerMode !== 'anthropic_only') {
          try {
            const availableLmStudioModels = await listLmStudioModels();
            availableLmStudioModelIds = availableLmStudioModels.map((model) => model.id);
          } catch (err) {
            if (effectiveAnswerMode === 'lmstudio_only') {
              const message = err instanceof Error ? err.message : 'Failed to fetch LM Studio models';
              throw new RoutingDecisionError('LMSTUDIO_MODELS_UNAVAILABLE', message);
            }
            // two_tier_auto: treat as no LM Studio models available — routing will fall back to Anthropic
            availableLmStudioModelIds = [];
          }
        }

        const routingDecision = resolveRoutingDecision({
          configuredAnswerMode,
          requestAnswerMode,
          requestLmStudioModel: lmStudioModel,
          modelTier,
          question,
          bestScore,
          lowConfidenceThreshold: lowConfidence,
          intent: effectiveIntent,
          retrievalMode,
          chunks: chunks.map((chunk) => ({ score: chunk.score, document_id: chunk.document_id })),
          anthropicAvailable,
          availableLmStudioModelIds,
          defaultLmStudioModel:
            process.env.DEFAULT_LMSTUDIO_MODEL
            ?? process.env.DEFAULT_ANSWER_MODEL
            ?? 'openai/gpt-oss-20b',
          qualityLmStudioModel:
            process.env.QUALITY_LMSTUDIO_MODEL
            ?? process.env.QUALITY_ANSWER_MODEL
            ?? process.env.DEFAULT_LMSTUDIO_MODEL
            ?? process.env.DEFAULT_ANSWER_MODEL
            ?? 'openai/gpt-oss-20b',
          defaultAnthropicModel: process.env.ANTHROPIC_DEFAULT_MODEL ?? 'claude-sonnet-4-5',
          qualityAnthropicModel: process.env.ANTHROPIC_QUALITY_MODEL ?? 'claude-opus-4-5',
        });

        push('routing', routingDecision);
        push('provider', {
          requested: requestAnswerMode ?? configuredAnswerMode,
          resolved: routingDecision.provider_used,
          anthropicEnabled: anthropicAvailable,
          fallbackApplied: routingDecision.quality_mode_reason.includes('anthropic_unavailable_fallback_local'),
          lmStudioModel: routingDecision.provider_used === 'lmstudio' ? routingDecision.model_used : null,
        });

        if (chunks.length === 0 || bestScore < minGrounded) {
          push('sources', { chunks: [] });
          push('token', { text: NO_EVIDENCE_MESSAGE });
          push('done', { ok: true });
          controller.close();
          return;
        }

        // Step 6: Format chunks
        const citedChunks = formatChunksForPrompt(chunks);
        const chunksWithContent = formatChunksWithContent(chunks);
        const evidenceSummary =
          retrievalMode === 'synthesis' || retrievalMode === 'canonical'
            ? summariseRuleEvidence(citedChunks)
            : null;

        const evidencePolicyHint =
          effectiveIntent === 'canonical_lookup' || effectiveIntent === 'synthesis_list' || effectiveIntent === 'synthesis_rules'
            ? buildSynthesisEvidencePolicyHint(effectiveIntent, evidenceSummary)
            : '';

        // Step 7: Build system prompt (with optional low-confidence caveat)
        let systemPrompt = SYSTEM_PROMPT;
        if (retrievalMode === 'interaction') {
          systemPrompt = INTERACTION_EXPLANATION_PROMPT;
        } else if (retrievalMode === 'synthesis' || retrievalMode === 'canonical') {
          systemPrompt =
            effectiveIntent === 'canonical_lookup'
              ? SYNTHESIS_CANONICAL_PROMPT
              :
            effectiveIntent === 'synthesis_rules'
              ? SYNTHESIS_RULES_PROMPT
              : SYNTHESIS_SYSTEM_PROMPT;
        }
        systemPrompt = `${systemPrompt}\n\n${buildAnswerStylePolicy(effectiveAnswerStyle)}`;
        if (bestScore < lowConfidence) {
          systemPrompt = LOW_CONFIDENCE_CAVEAT + systemPrompt;
        }

        // Step 8: Send sources event FIRST
        push('sources', { chunks: citedChunks });

        // Step 9: Build answer message and stream
        let answerMessage: string;
        let persistedHintTerms: string[] = [];
        if (retrievalMode === 'interaction') {
          const priorContext = inheritInteractionMode
            ? priorContextText
            : undefined;
          const interactionFrameModel = buildInteractionOperatingFrame(chunksWithContent);
          const interactionFrame = formatInteractionOperatingFrame(interactionFrameModel);
          persistedHintTerms = Array.from(
            new Set([
              ...interactionFrameModel.integrationMechanism,
              ...interactionFrameModel.failurePoints,
              ...interactionFrameModel.fallbackPaths,
            ]),
          )
            .filter((term) => term.trim().length > 0)
            .slice(0, 10);
          answerMessage = buildInteractionAnswerMessage(
            question,
            chunksWithContent,
            buildSynthesisContext(citedChunks),
            interactionFrame,
            priorContext,
          );
        } else if (retrievalMode === 'synthesis' || retrievalMode === 'canonical') {
          answerMessage = buildSynthesisAnswerMessage(
            question,
            chunksWithContent,
            buildSynthesisContext(citedChunks),
            evidencePolicyHint,
          );
        } else {
          answerMessage = buildAnswerMessage(question, chunksWithContent);
        }

        const tokenStream = generateStream(
          systemPrompt,
          answerMessage,
          conversationHistory,
          modelTier,
          routingDecision.provider_used,
          routingDecision.model_used,
        );

        let fullAnswer = '';
        const GENERATION_TIMEOUT = 30000; // 30 seconds
        const FIRST_TOKEN_TIMEOUT = 15000; // 15 seconds to get first token

        try {
          let firstTokenReceived = false;
          const streamPromise = (async () => {
            for await (const text of tokenStream) {
              firstTokenReceived = true;
              fullAnswer += text;
            }
          })();

          // Race between the stream and timeout for first token
          if (!firstTokenReceived) {
            await Promise.race([
              streamPromise,
              new Promise((_, reject) =>
                setTimeout(
                  () => reject(new Error('No response from model within ' + FIRST_TOKEN_TIMEOUT + 'ms')),
                  FIRST_TOKEN_TIMEOUT
                )
              ),
            ]).catch(() => {
              // Timeout occurred, but continue with fallback
            });
          }

          // If we got some tokens, wait for the rest (with full timeout)
          if (firstTokenReceived) {
            await Promise.race([
              streamPromise,
              new Promise((_, reject) =>
                setTimeout(
                  () => reject(new Error('Generation timeout')),
                  GENERATION_TIMEOUT
                )
              ),
            ]).catch(() => {
              // Timeout, proceed with what we have
            });
          }
        } catch {
          // Generation error, proceed with fallback if needed
        }

        const uniqueDocs = new Set(citedChunks.map((chunk) => `${chunk.doc_title}|||${chunk.folder}`));
        const requiredCount = uniqueDocs.size > 1 ? 2 : 1;
        const fallbackLabels = Array.from(new Set(citedChunks.map((chunk) => chunk.citation_label))).slice(
          0,
          requiredCount,
        );

        // If we got no answer from the model, provide a fallback
        if (fullAnswer.trim().length === 0) {
          fullAnswer = 'I was unable to generate a response. The sources above may contain the information you need. Please try your question again or consult the documents directly.';
        }


        const { answerText } = normalizeAnswerWithReferences(fullAnswer, {
          fallbackLabels,
          noEvidenceMessage: NO_EVIDENCE_MESSAGE,
        });

        if (answerText.trim().length > 0) {
          push('token', { text: answerText });
        }

        if (retrievalMode === 'interaction') {
          const interactionContext: InteractionContext = {
            systemA: interactionOptions.interaction?.systemA,
            systemB: interactionOptions.interaction?.systemB,
            lastIntent: 'interaction_explanation',
            retrievedDocIds: Array.from(
              new Set(
                citedChunks
                  .map((chunk) => chunk.document_id)
                  .filter((id): id is string => typeof id === 'string' && id.length > 0),
              ),
            ),
            hintTerms: persistedHintTerms,
          };
          push('interaction_context', interactionContext);
          push('token', { text: serializeInteractionContext(interactionContext) });
        }

        push('done', { ok: true });
      } catch (err) {
        if (err instanceof RoutingDecisionError) {
          push('error', { message: err.message, code: err.code });
          return;
        }
        const message = err instanceof Error ? err.message : 'Internal server error';
        push('error', { message, code: 'INTERNAL_ERROR' });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
