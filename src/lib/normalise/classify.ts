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
  /^\s*[-*•]\s+/m,
];

const IMPERATIVE_VERBS = new Set([
  'ensure', 'record', 'check', 'verify', 'place', 'remove', 'add',
  'measure', 'incubate', 'centrifuge', 'pipette', 'transfer', 'label',
  'mix', 'prepare', 'wash', 'clean', 'dry', 'store', 'seal', 'open',
  'close', 'press', 'click', 'select', 'enter', 'navigate', 'save',
  'submit', 'approve', 'reject', 'run', 'start', 'stop', 'load',
  'calibrate', 'review', 'scan', 'print',
]);

const REVISION_HEADING = /revision|amendment|version\s+history|change\s+history|document\s+history/i;
const APPENDIX_HEADING = /appendix|annex/i;
const METADATA_HEADING = /document\s+control|approval|distribution|authoris/i;
const NOTE_HEADING = /note|reference|see also/i;
const OCR_GARBAGE_PATTERN = /([\uFFFD]{2,}|\?{4,}|\b[0OIl]{8,}\b)/;
const TABLE_DELIMITER_PATTERN = /[,|\t;]/;
const TABLE_REFERENCE_SIGNAL = /\b(code|codes|parameter|result|results|method|test|limit|range|unit|setting|calibration|reference|description)\b/i;
const LIST_REFERENCE_SIGNAL = /\b(code|codes|parameter|result|results|method|test|limit|range|unit|setting|table|appendix|reference)\b/i;
const PROCEDURAL_SIGNAL = /\b(open|select|enter|click|run|verify|check|start|stop|load|save|submit|record|confirm|navigate|calibrate|review|scan|print)\b/i;

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

function isLikelyOcrGarbage(content: string): boolean {
  const text = content.trim();
  if (!text) return true;
  if (OCR_GARBAGE_PATTERN.test(text)) return true;
  const alnum = (text.match(/[a-z0-9]/gi) ?? []).length;
  const symbols = (text.match(/[^\sa-z0-9]/gi) ?? []).length;
  if (alnum === 0) return true;
  return symbols / (alnum + symbols) > 0.55;
}

function isReferenceTable(content: string): boolean {
  const lines = content.split('\n').map(line => line.trim()).filter(Boolean);
  if (lines.length < 2) return false;
  const first = lines[0];
  const second = lines[1] ?? '';
  const hasGridLikeLayout = TABLE_DELIMITER_PATTERN.test(first) || TABLE_DELIMITER_PATTERN.test(second);
  if (!hasGridLikeLayout) return false;
  return TABLE_REFERENCE_SIGNAL.test(content);
}

function isReferenceList(content: string): boolean {
  const trimmed = content.trim();
  const isBulletOrList = /^[-*•]/.test(trimmed) || /^\d+[.)]/.test(trimmed);
  if (!isBulletOrList) return false;
  return LIST_REFERENCE_SIGNAL.test(content);
}

function hasMeaningfulBodyBeyondFooter(content: string): boolean {
  const lines = content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !FOOTER_HEADER_PATTERNS.some((p) => p.test(line)))
    .filter((line) => !/authori[sz]ed by|version\s+\d+|quality manager/i.test(line));
  if (lines.length === 0) return false;

  const body = lines.join(' ');
  const bodyTokens = tokenCount(body);
  if (bodyTokens < 5) return false;

  if (PROCEDURAL_SIGNAL.test(body)) return true;
  if (/^[-*•]/m.test(body)) return true;
  if (TABLE_REFERENCE_SIGNAL.test(body)) return true;
  return bodyTokens >= 10;
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
  exclusionTag?: string,
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
      ...(exclusionTag ? { exclusion_tag: exclusionTag } : {}),
    },
  };
}

// --- Main classifier ---

export function classifySections(
  sections: ExtractedSection[],
  _documentTitle: string,
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
      if (hasMeaningfulBodyBeyondFooter(content)) {
        result.push(buildNormalisedSection(
          section, 'instruction_block', 0.72,
          'Footer/header marker detected but retained because chunk contains meaningful procedural body text',
          false, false,
          'broken_structure',
        ));
        continue;
      }

      result.push(buildNormalisedSection(
        section, 'footer_header', 0.9,
        'Content matches known footer/header pattern (watermark, page number, controlled copy)',
        true, false,
        'metadata_block',
      ));
      continue;
    }

    // --- Rule 1b: OCR garbage / unreadable fragments ---
    if (isLikelyOcrGarbage(content)) {
      result.push(buildNormalisedSection(
        section, 'metadata_only', 0.9,
        'Content appears to be OCR garbage or symbol-dominant noise',
        true, false,
        'ocr_garbage',
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
        'metadata_block',
      ));
      continue;
    }
    if (headingHasAppendixForm && tokens < 10 && isContentEmpty(content)) {
      result.push(buildNormalisedSection(
        section, 'form_stub', 0.9,
        'Under appendix/forms/spreadsheets heading with N/A or minimal content',
        true, false,
        'metadata_block',
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
      const tableReference = isReferenceTable(content);
      result.push(buildNormalisedSection(
        section, 'table', 0.95,
        tableReference ? 'Table content appears to contain useful code/parameter/result reference data' : 'Table content appears to be low-information grid noise',
        !tableReference, false,
        tableReference ? 'table_reference' : 'table_noise',
      ));
      continue;
    }

    // --- Rule 5b: list reference blocks ---
    if (section.type === 'list' && isReferenceList(content)) {
      result.push(buildNormalisedSection(
        section, 'note', 0.8,
        'List content appears to be useful procedural/reference bullets',
        false, false,
        'list_reference',
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
        'metadata_block',
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
