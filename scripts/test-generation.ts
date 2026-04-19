import * as dotenv from 'dotenv';
import { generateSync } from '@/lib/generation';
import * as path from 'path';

// Load .env.local manually
dotenv.config({ path: path.join(process.cwd(), '.env.local') });

const systemPrompt = 'You are a helpful assistant. Answer the question directly.';
const userMessage = 'What is 2+2?';

async function test() {
  console.log('Testing generateSync...');
  console.log('ANTHROPIC_API_KEY:', process.env.ANTHROPIC_API_KEY ? 'SET' : 'MISSING');
  try {
    const answer = await generateSync(systemPrompt, userMessage, 'default');
    console.log('Answer:', answer || '(empty)');
    console.log('Answer length:', answer?.length ?? 0);
  } catch (err) {
    console.error('Error:', err instanceof Error ? err.message : err);
    console.error('Stack:', err instanceof Error ? err.stack : '');
  }
}

test();
