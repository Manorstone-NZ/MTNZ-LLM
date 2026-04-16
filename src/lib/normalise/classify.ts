import type { ExtractedSection, NormalisedSection, SectionType } from '../types';

// --- Pattern constants ---

const FOOTER_HEADER_PATTERNS = [
  /CONTROLLED COPY/i,
  /IF THIS LINE IS GREEN/i,
  /THIS DOCUMENT IS UNCONTROLLED/i,
  /^\s*(?:Page\s+)?\d+\s*(?:of\s+\d+)?\s*$/i,
  /^\s*\d+\s*$/,
];

const FORM_STUB_HEADING = /forms|spreadsheets/i;
const FORM_STUB_APPENDIX_HEADING = /appendix|forms|spreadsheets/i;
const NA_CONTENT = /^\s*(?:N\/?A|n\/?a|None|none|-|—|–)\s*$/;

const WARNING_STARTS = /^\s*(?:WARNING|CAUTION|NOTE:|IMPORTANT:|CRITICAL:|DANGER|SAFETY)\b/i;

const NUMBERED_STEP_PATTERNS = [
  /^\s*\d+[.)]\s/m,
  /^\s*[a-z][.)]\s/m,
  /^\s*[ivx]+[.)]\s/m,
  /^\s*Step\s+\d+/im,
];

const IMPERATIVE_VERBS = new Set([
  'ensure', 'record', 'check', 'verify', 'place', 'remove', 'add',
  'measure', 'incubate', 'centrifuge', 'pipette', 'transfer', 'label',
  'mix', 'prepare', 'wash', 'clean', 'dry', 'store', 'seal', 'open',
  'close', 'press', 'click', 'select', 'enter', 'navigate', 'save',
  'submit', 'approve', 'reject',
]);

const REVISION_HEADING = /revision|amendment|version\s+history|change\s+history|document\s+history/i;
const APPENDIX_HEADING = /appendix|annex/i;
const METADATA_HEADING = /document\s+control|approval|distribution|authoris/i;
const NOTE_HEADING = /note|reference|see also/i;

// --- Helpers ---

/** Rough token count (whitespace split). */
function tokenCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Check if content contains at least one imperative verb. */
function findImperativeVerbs(content: string): string[] {
  const lower = content.toLowerCase();
  const words = lower.split(/[\s,;:.!?()\[\]{}]+/).filter(Boolean);
  return words.filter(w => IMPERATIVE_VERBS.has(w));
}

/** Check if content has a direct-object pattern: verb + noun-ish word. */
function hasDirectObjectPattern(content: string): boolean {
  const lower = content.toLowerCase();
  for (const verb of IMPERATIVE_VERBS) {
    // verb followed by a/an/the/word
    const re = new RegExp(`\\b${verb}\\s+(?:a|an|the|each|all|any)?\\s*\\w+`, 'i');
    if (re.test(lower)) return true;
  }
  return false;
}

function isContentEmpty(content: string): boolean {
  const trimmed = content.trim();
  return trimmed === '' || NA_CONTENT.test(trimmed);
}

function matchesAnyPattern(text: string, patterns: RegExp[]): boolean {
  return patterns.some(p => p.test(text));
}

// --- Heading stack ---

interface HeadingContext {
  title: string;
  level: number;
}

function updateHeadingStack(
  stack: HeadingContext[],
  section: ExtractedSection
): HeadingContext[] {
  if (section.type === 'heading' && section.title) {
    const level = section.level ?? 1;
    // Pop headings at same or deeper level
    const newStack = stack.filter(h => h.level < level);
    newStack.push({ title: section.title, level });
    return newStack;
  }
  // Non-heading with a title: treat as same-level context update
  if (section.title && section.level != null) {
    const level = section.level;
    const newStack = stack.filter(h => h.level < level);
    newStack.push({ title: section.title, level });
    return newStack;
  }
  return stack;
}

function anyHeadingMatches(stack: HeadingContext[], pattern: RegExp): boolean {
  return stack.some(h => pattern.test(h.title));
}

// --- Build result helper ---

function buildNormalisedSection(
  section: ExtractedSection,
  sectionType: SectionType,
  confidence: number,
  matchedRule: string,
  excluded: boolean,
  downranked: boolean,
): NormalisedSection {
  return {
    ...section,
    section_type: sectionType,
    section_type_confidence: confidence,
    retrieval_excluded: excluded,
    retrieval_downranked: downranked,
    is_boilerplate: false,
    boilerplate_hash: null,
    normalisation_reason: {
      classification: sectionType,
      confidence,
      matched_rule: matchedRule,
    },
  };
}

// --- Main classifier ---

export function classifySections(
  sections: ExtractedSection[],
  documentTitle: string,
): NormalisedSection[] {
  const result: NormalisedSection[] = [];
  let headingStack: HeadingContext[] = [];

  for (const section of sections) {
    // Update heading context
    headingStack = updateHeadingStack(headingStack, section);

    const content = section.content ?? '';
    const title = section.title ?? '';
    const tokens = tokenCount(content);

    // --- Rule 1: footer_header ---
    if (matchesAnyPattern(content, FOOTER_HEADER_PATTERNS)) {
      result.push(buildNormalisedSection(
        section, 'footer_header', 0.9,
        'Content matches known footer/header pattern (watermark, page number, controlled copy)',
        true, false,
      ));
      continue;
    }

    // --- Rule 2: form_stub ---
    const headingHasForm = FORM_STUB_HEADING.test(title) ||
      anyHeadingMatches(headingStack, FORM_STUB_HEADING);
    const headingHasAppendixForm = FORM_STUB_APPENDIX_HEADING.test(title) ||
      anyHeadingMatches(headingStack, FORM_STUB_APPENDIX_HEADING);

    if (headingHasForm && (isContentEmpty(content) || (tokens < 10 && !content.trim()))) {
      result.push(buildNormalisedSection(
        section, 'form_stub', 0.9,
        'Heading contains FORMS/SPREADSHEETS and content is empty or N/A',
        true, false,
      ));
      continue;
    }
    if (headingHasAppendixForm && tokens < 10 && isContentEmpty(content)) {
      result.push(buildNormalisedSection(
        section, 'form_stub', 0.9,
        'Under appendix/forms/spreadsheets heading with N/A or minimal content',
        true, false,
      ));
      continue;
    }

    // --- Rule 3: warning ---
    if (WARNING_STARTS.test(content)) {
      result.push(buildNormalisedSection(
        section, 'warning', 0.9,
        'Content starts with WARNING/CAUTION/NOTE:/IMPORTANT:/CRITICAL:/DANGER/SAFETY',
        false, false,
      ));
      continue;
    }

    // --- Rule 4: procedure_step ---
    const hasNumberedStep = matchesAnyPattern(content, NUMBERED_STEP_PATTERNS);
    const imperativeVerbs = findImperativeVerbs(content);
    if (hasNumberedStep && imperativeVerbs.length > 0) {
      result.push(buildNormalisedSection(
        section, 'procedure_step', 0.9,
        `Numbered step pattern with imperative verb(s): ${imperativeVerbs.slice(0, 3).join(', ')}`,
        false, false,
      ));
      continue;
    }

    // --- Rule 5: table ---
    if (section.type === 'table') {
      result.push(buildNormalisedSection(
        section, 'table', 0.95,
        'Extraction type was table',
        false, false,
      ));
      continue;
    }

    // --- Rule 6: instruction_block ---
    if (imperativeVerbs.length >= 2 || (imperativeVerbs.length >= 1 && hasDirectObjectPattern(content))) {
      result.push(buildNormalisedSection(
        section, 'instruction_block', 0.8,
        `Contains imperative verb(s) without step numbering: ${imperativeVerbs.slice(0, 3).join(', ')}`,
        false, false,
      ));
      continue;
    }

    // --- Rule 7: revision_history ---
    if (anyHeadingMatches(headingStack, REVISION_HEADING) || REVISION_HEADING.test(title)) {
      result.push(buildNormalisedSection(
        section, 'revision_history', 0.85,
        'Under revision/amendment/version history heading',
        false, true,
      ));
      continue;
    }

    // --- Rule 8: appendix ---
    if (anyHeadingMatches(headingStack, APPENDIX_HEADING) || APPENDIX_HEADING.test(title)) {
      result.push(buildNormalisedSection(
        section, 'appendix', 0.8,
        'Under appendix/annex heading',
        false, true,
      ));
      continue;
    }

    // --- Rule 9: metadata_only ---
    if (anyHeadingMatches(headingStack, METADATA_HEADING) || METADATA_HEADING.test(title)) {
      result.push(buildNormalisedSection(
        section, 'metadata_only', 0.8,
        'Under document control/approval/distribution/authorisation heading',
        false, true,
      ));
      continue;
    }

    // --- Rule 10: heading ---
    if (section.type === 'heading') {
      result.push(buildNormalisedSection(
        section, 'heading', 0.95,
        'Extraction type was heading',
        false, false,
      ));
      continue;
    }

    // --- Rule 11: note ---
    if (tokens < 100 && (anyHeadingMatches(headingStack, NOTE_HEADING) || NOTE_HEADING.test(title))) {
      result.push(buildNormalisedSection(
        section, 'note', 0.7,
        'Short content under note/reference/see also heading',
        false, false,
      ));
      continue;
    }

    // --- Rule 12: paragraph (default) ---
    result.push(buildNormalisedSection(
      section, 'paragraph', 0.5,
      'Default classification — no specific rule matched',
      false, false,
    ));
  }

  return result;
}
