import { listLmStudioModels, isAnthropicProviderAvailableFromEnv } from '@/lib/generation';
import { resolveConfiguredAnswerModeFromEnv } from '@/lib/answerRouting';

export async function GET() {
  try {
    const models = await listLmStudioModels();
    return Response.json({
      answerMode: resolveConfiguredAnswerModeFromEnv(process.env),
      models,
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
      anthropicEnabled: isAnthropicProviderAvailableFromEnv(process.env),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to fetch LM Studio models';
    return Response.json({ error: message, models: [] }, { status: 503 });
  }
}
