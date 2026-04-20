async function testQuery(question: string) {
  console.log(`\nTesting: "${question}"\n`);

  try {
    const response = await fetch('http://localhost:3000/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question,
        conversationHistory: [],
        modelTier: 'default',
      }),
    });

    if (!response.ok) {
      console.error(`HTTP ${response.status}`);
      return;
    }

    let answer = '';
    let sourceCount = 0;
    let sawToken = false;

    const textDecoder = new TextDecoder();
    for await (const chunk of response.body as any) {
      const text = textDecoder.decode(chunk);
      const lines = text.split('\n\n');
      for (const line of lines) {
        if (line.startsWith('event:') && line.includes('data:')) {
          const eventMatch = line.match(/event:\s*(\w+)/);
          const dataMatch = line.match(/data:\s*([\s\S]+)/);
          if (eventMatch && dataMatch) {
            const event = eventMatch[1];
            try {
              const data = JSON.parse(dataMatch[1]);
              if (event === 'token' && data.text) {
                answer += data.text;
                sawToken = true;
              } else if (event === 'sources' && data.chunks) {
                sourceCount = data.chunks.length;
              }
            } catch {
              // ignore
            }
          }
        }
      }
    }

    console.log(`Sources: ${sourceCount}`);
    console.log(`Saw tokens: ${sawToken}`);
    console.log(`Answer length: ${answer.length}`);
    if (answer) {
      console.log(`Answer preview: ${answer.slice(0, 200)}...`);
    } else {
      console.log('Answer: (empty)');
    }
  } catch (err) {
    console.error('Error:', err instanceof Error ? err.message : err);
  }
}

const queries = [
  'What is MADCAP?',  // standard
  'What MADCAP microbiology test codes are documented?', // synthesis_list
  'How does MADCAP interact with the sorter?', // interaction
];

(async () => {
  for (const q of queries) {
    await testQuery(q);
  }
})();

export {};
