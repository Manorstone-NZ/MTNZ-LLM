import { NextRequest } from 'next/server';
import { hybridSearch } from '@/lib/retrieval';
import { formatChunksForPrompt, formatChunksWithContent } from '@/lib/citations';
import {
  SYSTEM_PROMPT,
  buildAnswerMessage,
  LOW_CONFIDENCE_CAVEAT,
  NO_EVIDENCE_MESSAGE,
} from '@/lib/prompts';
import { generateStream } from '@/lib/generation';
import { embedText } from '@/lib/embeddings';
import type { ModelTier } from '@/lib/generation';

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
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

        // Step 2: Hybrid search
        const chunks = await hybridSearch(question);

        // Step 3: Thresholds
        const minGrounded = parseFloat(process.env.MIN_GROUNDED_SCORE ?? '0.18');
        const lowConfidence = parseFloat(process.env.LOW_CONFIDENCE_SCORE ?? '0.30');

        // Step 4: Check if we have usable results
        const bestScore = chunks.length > 0 ? Math.max(...chunks.map((c) => c.score)) : 0;

        if (chunks.length === 0 || bestScore < minGrounded) {
          push('sources', { chunks: [] });
          push('token', { text: NO_EVIDENCE_MESSAGE });
          push('done', { ok: true });
          controller.close();
          return;
        }

        // Step 5: Build system prompt (with optional low-confidence caveat)
        let systemPrompt = SYSTEM_PROMPT;
        if (bestScore < lowConfidence) {
          systemPrompt = LOW_CONFIDENCE_CAVEAT + systemPrompt;
        }

        // Step 6: Format chunks
        const citedChunks = formatChunksForPrompt(chunks);
        const chunksWithContent = formatChunksWithContent(chunks);

        // Step 7: Send sources event FIRST
        push('sources', { chunks: citedChunks });

        // Step 8: Build answer message and stream
        const answerMessage = buildAnswerMessage(question, chunksWithContent);
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
