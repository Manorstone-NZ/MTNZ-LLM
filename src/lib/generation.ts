import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

// ---------------------------------------------------------------------------
// Provider detection
// ---------------------------------------------------------------------------

function isAnthropicProviderAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export type ModelProviderMode = 'auto' | 'anthropic' | 'lmstudio';

export function resolveProviderMode(
  requestedMode: ModelProviderMode = 'auto',
  anthropicAvailable: boolean = isAnthropicProviderAvailable(),
): 'anthropic' | 'lmstudio' {
  if (requestedMode === 'anthropic') {
    return anthropicAvailable ? 'anthropic' : 'lmstudio';
  }
  if (requestedMode === 'lmstudio') {
    return 'lmstudio';
  }
  return anthropicAvailable ? 'anthropic' : 'lmstudio';
}

// ---------------------------------------------------------------------------
// LM Studio (OpenAI-compatible) client
// ---------------------------------------------------------------------------

const lmStudioClient = new OpenAI({
  baseURL: process.env.LMSTUDIO_URL! + '/v1',
  apiKey: 'lm-studio',
});

// ---------------------------------------------------------------------------
// Anthropic client (lazy — only constructed when key is present)
// ---------------------------------------------------------------------------

let _anthropicClient: Anthropic | null = null;
function getAnthropicClient(): Anthropic {
  if (!_anthropicClient) {
    _anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  }
  return _anthropicClient;
}

export type ModelTier = 'default' | 'quality';

function getModelId(tier: ModelTier, provider: 'anthropic' | 'lmstudio'): string {
  if (provider === 'anthropic') {
    return tier === 'quality'
      ? (process.env.ANTHROPIC_QUALITY_MODEL ?? 'claude-opus-4-5')
      : (process.env.ANTHROPIC_DEFAULT_MODEL ?? 'claude-sonnet-4-5');
  }
  return tier === 'quality'
    ? process.env.QUALITY_ANSWER_MODEL!
    : process.env.DEFAULT_ANSWER_MODEL!;
}

// ---------------------------------------------------------------------------
// Anthropic streaming path
// ---------------------------------------------------------------------------

async function* generateStreamAnthropic(
  systemPrompt: string,
  userMessage: string,
  conversationHistory: ChatCompletionMessageParam[],
  model: string,
): AsyncIterable<string> {
  const client = getAnthropicClient();

  const messages = [
    ...conversationHistory.filter((m) => m.role !== 'system').map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: typeof m.content === 'string' ? m.content : '',
    })),
    { role: 'user' as const, content: userMessage },
  ];

  const stream = client.messages.stream({
    model,
    system: systemPrompt,
    messages,
    max_tokens: 4096,
  });

  for await (const event of stream) {
    if (
      event.type === 'content_block_delta' &&
      event.delta.type === 'text_delta'
    ) {
      yield event.delta.text;
    }
  }
}

// ---------------------------------------------------------------------------
// Anthropic non-streaming path
// ---------------------------------------------------------------------------

async function generateSyncAnthropic(
  systemPrompt: string,
  userMessage: string,
  model: string,
): Promise<string> {
  const client = getAnthropicClient();
  const response = await client.messages.create({
    model,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
    max_tokens: 4096,
  });

  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => (block as { type: 'text'; text: string }).text)
    .join('');
}

/**
 * Streaming chat completion. Returns an async iterable of text chunks.
 * Routes to Anthropic when ANTHROPIC_API_KEY is set, otherwise LM Studio.
 */
export async function* generateStream(
  systemPrompt: string,
  userMessage: string,
  conversationHistory: ChatCompletionMessageParam[] = [],
  tier: ModelTier = 'default',
  providerMode: ModelProviderMode = 'auto',
): AsyncIterable<string> {
  const provider = resolveProviderMode(providerMode);
  const model = getModelId(tier, provider);

  if (provider === 'anthropic') {
    yield* generateStreamAnthropic(systemPrompt, userMessage, conversationHistory, model);
    return;
  }

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...conversationHistory,
    { role: 'user', content: userMessage },
  ];

  try {
    const stream = await lmStudioClient.chat.completions.create({
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
    const response = await lmStudioClient.chat.completions.create({
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
 * Routes to Anthropic when ANTHROPIC_API_KEY is set, otherwise LM Studio.
 */
export async function generateSync(
  systemPrompt: string,
  userMessage: string,
  tier: ModelTier = 'default',
  providerMode: ModelProviderMode = 'auto',
): Promise<string> {
  const provider = resolveProviderMode(providerMode);
  const model = getModelId(tier, provider);

  if (provider === 'anthropic') {
    return generateSyncAnthropic(systemPrompt, userMessage, model);
  }

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];

  const response = await lmStudioClient.chat.completions.create({
    model,
    messages,
    stream: false,
  });

  return response.choices[0]?.message?.content ?? '';
}
