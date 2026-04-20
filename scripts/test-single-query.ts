async function testQuery() {
  const query = 'List all MADCAP test types used across active databases.';
  
  console.log(`Testing query: "${query}"\n`);

  try {
    const response = await fetch('http://localhost:3000/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: query,
        conversationHistory: [],
        modelTier: 'default',
      }),
    });

    if (!response.ok) {
      console.error(`HTTP ${response.status}: ${response.statusText}`);
      const text = await response.text();
      console.error('Response body:', text.slice(0, 500));
      return;
    }

    let answer = '';
    let sources: unknown = null;

    const textDecoder = new TextDecoder();
    for await (const chunk of response.body as any) {
      const text = textDecoder.decode(chunk);
      const lines = text.split('\n\n');
      for (const line of lines) {
        if (line.startsWith('event:')) {
          const eventMatch = line.match(/event:\s*(\w+)/);
          const dataMatch = line.match(/data:\s*([\s\S]+)/);
          if (eventMatch && dataMatch) {
            const event = eventMatch[1];
            try {
              const data = JSON.parse(dataMatch[1]);
              if (event === 'token' && data.text) {
                answer += data.text;
              } else if (event === 'sources' && data.chunks) {
                sources = data.chunks;
                console.log(`Sources retrieved: ${data.chunks.length} chunks`);
              } else if (event === 'done') {
                console.log('Stream done');
              }
            } catch {
              // ignore parse errors
            }
          }
        }
      }
    }

    console.log('\n--- ANSWER ---');
    console.log(answer || '(empty)');
    console.log('\n--- SOURCE COUNT ---');
    console.log(sources ? (sources as any[]).length : 0);
  } catch (err) {
    console.error('Error:', err instanceof Error ? err.message : err);
  }
}

testQuery();

export {};
