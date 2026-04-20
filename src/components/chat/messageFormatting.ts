function normalizeBreakTags(content: string): string {
  return content.replace(/<br\s*\/?>/gi, '<line-break />');
}

function stripInteractionContextComment(content: string): string {
  return content.replace(/\s*<!--\s*INTERACTION_CONTEXT:[\s\S]*?-->/g, '').trimEnd();
}

function isReferenceListItem(line: string): boolean {
  const trimmed = line.trim();
  return /^[-*+]\s+/.test(trimmed) || /^[-*+]\s*$/.test(trimmed) || /^\d+\.\s+/.test(trimmed);
}

function isReferencesHeading(line: string): boolean {
  const t = line.trim().toLowerCase();
  // matches: "References:", "## References", "## References:", "### References", "**References:**"
  return /^#{1,4}\s*references:?\s*$/.test(t) || /^\*{1,2}references:\*{1,2}\s*$/.test(t) || t === 'references:' || t === 'references';
}

function stripReferencesSections(content: string): string {
  const lines = content.split('\n');
  const kept: string[] = [];
  let i = 0;

  while (i < lines.length) {
    if (!isReferencesHeading(lines[i])) {
      kept.push(lines[i]);
      i += 1;
      continue;
    }

    // Found a "References:" heading — consume everything until the next non-list, non-blank line
    let j = i + 1;
    while (j < lines.length) {
      const trimmed = lines[j].trim();
      if (trimmed.length === 0 || isReferenceListItem(lines[j])) {
        j += 1;
        continue;
      }
      break;
    }

    // Remove trailing blank lines from kept before the heading
    while (kept.length > 0 && kept[kept.length - 1].trim().length === 0) {
      kept.pop();
    }
    i = j;
  }

  return kept.join('\n').trimEnd();
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
  return replaceSourceCitations(normalizeBreakTags(stripReferencesSections(stripInteractionContextComment(content))));
}
