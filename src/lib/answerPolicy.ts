export type AnswerStyle = 'concise' | 'detailed';

const DETAILED_REQUEST_REGEX =
  /\b(detailed|detail|in depth|deep dive|step-by-step|thorough|comprehensive|full explanation|elaborate|expand)\b/i;

export function inferAnswerStyleFromQuestion(question: string): AnswerStyle {
  return DETAILED_REQUEST_REGEX.test(question) ? 'detailed' : 'concise';
}

export function resolveAnswerStyle(
  requestedStyle: AnswerStyle | undefined,
  question: string,
): AnswerStyle {
  if (requestedStyle === 'concise' || requestedStyle === 'detailed') {
    return requestedStyle;
  }
  return inferAnswerStyleFromQuestion(question);
}

export function buildAnswerStylePolicy(style: AnswerStyle): string {
  if (style === 'detailed') {
    return [
      'ANSWER STYLE POLICY:',
      '- Provide a detailed, structured answer with clear sections and practical context.',
      '- Include concise bullets where helpful, but do not omit important operational detail.',
      '- Keep grounded citations for each logical section.',
    ].join('\n');
  }

  return [
    'ANSWER STYLE POLICY:',
    '- Default to concise responses: start with a direct answer in 1-3 sentences.',
    '- Include only the most important supporting points unless detail is explicitly requested.',
    '- Keep the answer grounded and structured, but avoid unnecessary verbosity.',
    '- Preserve required source citations for key claims.',
  ].join('\n');
}
