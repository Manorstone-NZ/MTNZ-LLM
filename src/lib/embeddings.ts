import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: process.env.LMSTUDIO_URL! + '/v1',
  apiKey: 'lm-studio',
});

export async function embedText(text: string): Promise<number[]> {
  const response = await client.embeddings.create({
    model: process.env.EMBEDDING_MODEL!,
    input: text,
    encoding_format: 'float',
  });
  return response.data[0].embedding;
}

export async function embedBatch(
  texts: string[],
  batchSize = parseInt(process.env.EMBED_BATCH_SIZE || '32')
): Promise<number[][]> {
  const results: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const response = await client.embeddings.create({
      model: process.env.EMBEDDING_MODEL!,
      input: batch,
      encoding_format: 'float',
    });
    results.push(...response.data.map(d => d.embedding));
  }
  return results;
}
