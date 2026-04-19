console.log('Environment:');
console.log('DATABASE_URL:', process.env.DATABASE_URL ? 'SET' : 'MISSING');
console.log('SOURCE_PATH:', process.env.SOURCE_PATH);
console.log('ANTHROPIC_API_KEY:', process.env.ANTHROPIC_API_KEY ? 'SET' : 'MISSING');
console.log('LMSTUDIO_URL:', process.env.LMSTUDIO_URL);
console.log('DEFAULT_ANSWER_MODEL:', process.env.DEFAULT_ANSWER_MODEL);
console.log('QUALITY_ANSWER_MODEL:', process.env.QUALITY_ANSWER_MODEL);
console.log('ANTHROPIC_DEFAULT_MODEL:', process.env.ANTHROPIC_DEFAULT_MODEL);
console.log('ANTHROPIC_QUALITY_MODEL:', process.env.ANTHROPIC_QUALITY_MODEL);
