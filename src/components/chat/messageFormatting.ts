function normalizeBreakTags(content: string): string {
  return content.replace(/<br\s*\/?>/gi, '<line-break />');
}

function replaceSourceCitations(content: string): string {
  const parts = content.split(/(\[Source:\s*[^\]]+\])/g);
  if (parts.length === 1) return content;

  return parts
    .map((part) => {
      const match = part.match(/^\[Source:\s*([^\]]+)\]$/);
      if (match) {
        return `<source-badge label="${match[1].trim()}" />`;
      }
      return part;
    })
    .join('');
}

export function formatAssistantContent(content: string): string {
  return replaceSourceCitations(normalizeBreakTags(content));
}
