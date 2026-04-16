import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

const client = new OpenAI({
  baseURL: process.env.LMSTUDIO_URL! + '/v1',
  apiKey: 'lm-studio',
});

export type ModelTier = 'default' | 'quality';

function getModelId(tier: ModelTier): string {
  return tier === 'quality'
    ? process.env.QUALITY_ANSWER_MODEL!
    : process.env.DEFAULT_ANSWER_MODEL!;
}

/**
 * Streaming chat completion. Returns an async iterable of text chunks.
 * Falls back to a single non-streaming call if streaming fails.
 */
export async function* generateStream(
  systemPrompt: string,
  userMessage: string,
  conversationHistory: ChatCompletionMessageParam[] = [],
  tier: ModelTier = 'default'
): AsyncIterable<string> {
  const model = getModelId(tier);
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...conversationHistory,
    { role: 'user', content: userMessage },
  ];

  try {
    const stream = await client.chat.completions.create({
      model,
      messages,
      stream: true,
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        yield content;
      }
    }
  } catch {
    // Fallback: retry once without streaming
    const response = await client.chat.completions.create({
      model,
      messages,
      stream: false,
    });

    const text = response.choices[0]?.message?.content ?? '';
    if (text) {
      yield text;
    }
  }
}

/**
 * Non-streaming chat completion. Returns the full response text.
 * Used for query rewrite, validation, and other non-interactive passes.
 */
export async function generateSync(
  systemPrompt: string,
  userMessage: string,
  tier: ModelTier = 'default'
): Promise<string> {
  const model = getModelId(tier);
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];

  const response = await client.chat.completions.create({
    model,
    messages,
    stream: false,
  });

  return response.choices[0]?.message?.content ?? '';
}
