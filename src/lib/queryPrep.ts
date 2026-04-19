export interface QueryPrepResult {
  original: string;
  expanded: string;
  isStructural: boolean;
  sectionRefs: string[];
  documentRefs: string[];
}

export function prepareQuery(input: string): QueryPrepResult {
  const q = input.trim();

  const sectionRegex = /\b\d+(?:\.\d+)+\b/g;
  const documentRefRegex = /\b[A-Za-z]{2,4}-[A-Za-z]{2}\s*\d{3}\b/g;
  const appendixRegex = /\bappendix\b/i;
  const sectionWordRegex = /\bsection\b/i;
  const listRegex = /\b(list|full list|all|codes?)\b/i;

  const sectionRefs = q.match(sectionRegex) ?? [];
  const documentRefs = q.match(documentRefRegex) ?? [];

  const isStructural =
    appendixRegex.test(q) ||
    sectionWordRegex.test(q) ||
    listRegex.test(q) ||
    sectionRefs.length > 0;

  if (!isStructural) {
    return {
      original: q,
      expanded: q,
      isStructural: false,
      sectionRefs: [],
      documentRefs: [],
    };
  }

  const hints: string[] = [];

  if (appendixRegex.test(q)) {
    hints.push('appendix');
  }

  if (sectionRefs.length > 0) {
    hints.push(...sectionRefs);
  }

  if (documentRefs.length > 0) {
    hints.push(...documentRefs);
  }

  if (listRegex.test(q)) {
    hints.push('table', 'codes', 'list');
  }

  const hintText = hints.join(' ').trim();
  const expanded = hintText ? `${q} ${hintText}` : q;

  return {
    original: q,
    expanded,
    isStructural: true,
    sectionRefs,
    documentRefs,
  };
}