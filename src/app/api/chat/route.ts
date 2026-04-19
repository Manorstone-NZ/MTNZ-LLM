import { NextRequest } from 'next/server';
import { hybridSearchWithMode } from '@/lib/retrieval';
import { formatChunksForPrompt, formatChunksWithContent } from '@/lib/citations';
import {
  SYSTEM_PROMPT,
  SYNTHESIS_SYSTEM_PROMPT,
  SYNTHESIS_CANONICAL_PROMPT,
  SYNTHESIS_RULES_PROMPT,
  INTERACTION_EXPLANATION_PROMPT,
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
import { embedText } from '@/lib/embeddings';
import type { ModelTier } from '@/lib/generation';
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
  const { question, conversationHistory = [], modelTier = 'default' } = body as {
    question?: string;
    conversationHistory?: { role: 'user' | 'assistant'; content: string }[];
    modelTier?: ModelTier;
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
        // Step 1: Test LM Studio connectivity by embedding the question
        try {
          await embedText(question);
        } catch {
          push('error', { message: 'LM Studio is unavailable', code: 'LM_UNAVAILABLE' });
          controller.close();
          return;
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

        // Step 3: Hybrid search
        const chunks = await hybridSearchWithMode(retrievalQuestion, retrievalMode, interactionOptions);

        // Step 4: Thresholds
        const minGrounded = parseFloat(process.env.MIN_GROUNDED_SCORE ?? '0.18');
        const lowConfidence = parseFloat(process.env.LOW_CONFIDENCE_SCORE ?? '0.30');

        // Step 5: Check if we have usable results
        const bestScore = chunks.length > 0 ? Math.max(...chunks.map((c) => c.score)) : 0;

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

        let evidencePolicyHint = '';
        if (intentResult.intent === 'synthesis_rules' && evidenceSummary?.hasBroadRuleCoverage) {
          evidencePolicyHint = `Retrieved evidence spans multiple documents and contains substantial rule-like material.
Do NOT add a generic "available sources do not fully cover" limitations section unless a major rule category is unsupported.
Provide a confident consolidated rule model from the retrieved evidence.`;
        } else if (evidenceSummary?.hasStrongSynthesisCoverage) {
          evidencePolicyHint = `Retrieved evidence is strong across multiple documents.
${evidenceSummary.hasAuthoritativeSource
    ? '- Prioritize authoritative/canonical structured sources when presenting the final answer structure.'
    : '- No single authoritative source dominates; provide a grounded corpus-derived consolidation.'}
- Do NOT add generic incompleteness boilerplate unless major requested areas are unsupported.`;
        }

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
          modelTier
        );

        let fullAnswer = '';

        for await (const text of tokenStream) {
          fullAnswer += text;
          push('token', { text });
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

        // Enforce a minimum citation floor when the model omits citations.
        const citationMatches = fullAnswer.match(/\[Source:\s*[^\]]+\]/g) ?? [];
        const normalizedAnswer = fullAnswer.trim();
        if (citationMatches.length === 0 && !normalizedAnswer.includes(NO_EVIDENCE_MESSAGE)) {
          const uniqueDocs = new Set(citedChunks.map((chunk) => `${chunk.doc_title}|||${chunk.folder}`));
          const requiredCount = uniqueDocs.size > 1 ? 2 : 1;
          const uniqueLabels = Array.from(new Set(citedChunks.map((chunk) => chunk.citation_label))).slice(
            0,
            requiredCount
          );
          if (uniqueLabels.length > 0) {
            const citationSuffix = `\n\n${uniqueLabels
              .map((label) => `[Source: ${label}]`)
              .join(' ')}`;
            push('token', { text: citationSuffix });
          }
        }

        push('done', { ok: true });
      } catch (err) {
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
