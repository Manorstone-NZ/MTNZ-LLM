/**
 * PDF text quality scoring model.
 *
 * Evaluates extracted text (native or OCR) using five weighted signals
 * to produce a 0–1 score and a tier classification. Real lab-document
 * text scores > 0.8 ("good"), while garbled / OCR-artefact text falls
 * below 0.4 ("poor").
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QualityAssessment {
  score: number; // 0.0–1.0
  tier: 'good' | 'partial' | 'poor';
  source: 'native_extraction' | 'ocr_output';
  signals: {
    printable_ratio: number;
    avg_token_length: number;
    dictionary_hit_rate: number;
    pages_with_text_ratio: number;
    suspicious_pattern_rate: number;
  };
}

// ---------------------------------------------------------------------------
// Domain terms + common English words (~200 entries)
// ---------------------------------------------------------------------------

const DOMAIN_TERMS = new Set([
  // ── Systems ──
  'madcap', 'titan', 'lims', 'combifoss', 'milkoscan', 'bactoscan',
  'cryoscope', 'ilas', 'fossomatic',

  // ── Organisations ──
  'mpi', 'ianz', 'ospri', 'mtnz', 'milktest',

  // ── Test types ──
  'coliform', 'thermoduric', 'somatic', 'aflatoxin', 'antibiotics',
  'inhibitory', 'organoleptic', 'cryoscopy', 'titratable',

  // ── Biology / chemistry ──
  'bovis', 'mycoplasma', 'escherichia', 'coli', 'lactam', 'elisa',
  'pcr', 'chromatography', 'spectrophotometry',

  // ── Equipment ──
  'autoclave', 'centrifuge', 'incubator', 'pipette', 'petrifilm',

  // ── Lab terms ──
  'aliquot', 'reagent', 'calibration', 'accreditation', 'proficiency',
  'analyte', 'assay', 'specimen', 'homogenise', 'inoculate',

  // ── Procedures ──
  'sop', 'lop', 'eop', 'qm', 'ktp',

  // ── Common English words (baseline) ──
  'the', 'and', 'for', 'that', 'with', 'this', 'from', 'have', 'are',
  'was', 'were', 'been', 'being', 'will', 'would', 'should', 'could',
  'must', 'shall', 'may', 'can', 'not', 'but', 'all', 'each', 'which',
  'their', 'there', 'when', 'where', 'what', 'how', 'who', 'has', 'had',
  'does', 'did', 'into', 'than', 'then', 'them', 'these', 'those',
  'only', 'also', 'after', 'before', 'between', 'through', 'during',
  'sample', 'test', 'result', 'laboratory', 'procedure', 'method',
  'analysis', 'report', 'quality', 'control', 'standard', 'reference',
  'equipment', 'temperature', 'volume', 'weight', 'concentration',

  // ── Additional common English (to reach ~200) ──
  'about', 'above', 'across', 'again', 'against', 'along', 'already',
  'always', 'among', 'another', 'any', 'anything', 'area', 'around',
  'available', 'back', 'because', 'become', 'below', 'best', 'both',
  'case', 'change', 'check', 'complete', 'condition', 'consider',
  'contain', 'continue', 'data', 'date', 'day', 'department',
  'description', 'different', 'document', 'down', 'ensure', 'even',
  'every', 'example', 'expected', 'field', 'file', 'find', 'first',
  'follow', 'form', 'found', 'further', 'general', 'give', 'good',
  'group', 'high', 'however', 'important', 'include', 'information',
  'issue', 'item', 'its', 'just', 'keep', 'last', 'level', 'like',
  'line', 'list', 'long', 'look', 'made', 'main', 'make', 'many',
  'more', 'most', 'much', 'need', 'new', 'next', 'note', 'now',
  'number', 'off', 'one', 'order', 'other', 'out', 'over', 'own',
  'page', 'part', 'per', 'place', 'point', 'possible', 'present',
  'process', 'product', 'provide', 'range', 'record', 'related',
  'required', 'review', 'right', 'same', 'section', 'see', 'set',
  'several', 'show', 'since', 'some', 'specific', 'state', 'still',
  'such', 'system', 'take', 'time', 'total', 'two', 'type', 'under',
  'unit', 'until', 'upon', 'use', 'used', 'using', 'value', 'very',
  'water', 'way', 'well', 'work', 'year',
]);

// ---------------------------------------------------------------------------
// Signal helpers
// ---------------------------------------------------------------------------

/** Signal 1 – Printable/alphanumeric ratio (weight 0.25)
 *
 * The spec names this "printable/alphanumeric ratio". We measure
 * alphanumeric + whitespace characters as a fraction of total. This
 * distinguishes real text (mostly letters, digits, spaces) from
 * punctuation-heavy garbage while still penalising non-ASCII garble.
 */
function computePrintableRatio(text: string): number {
  if (text.length === 0) return 0;
  let clean = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const isAlpha =
      (code >= 65 && code <= 90) || (code >= 97 && code <= 122); // A-Z, a-z
    const isDigit = code >= 48 && code <= 57; // 0-9
    const isSpace = code === 32 || code === 9 || code === 10 || code === 13;
    // Allow common punctuation that appears in real text (.,-:;'")
    const isCommonPunct =
      code === 46 || code === 44 || code === 45 || code === 58 ||
      code === 59 || code === 39 || code === 34 || code === 40 ||
      code === 41 || code === 47;
    if (isAlpha || isDigit || isSpace || isCommonPunct) {
      clean++;
    }
  }
  return clean / text.length;
}

/** Signal 2 – Average token length sanity (weight 0.20) */
function computeAvgTokenLengthScore(tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const mean = tokens.reduce((sum, t) => sum + t.length, 0) / tokens.length;
  // Score 1.0 for mean in [3, 8], penalise linearly outside
  if (mean >= 3 && mean <= 8) return 1.0;
  if (mean < 3) {
    // Linear penalty: 0 at mean=0, 1.0 at mean=3  → but floor at 0
    return Math.max(0, mean / 3);
  }
  // mean > 8: linear penalty towards 0 at mean=12
  return Math.max(0, 1.0 - (mean - 8) / 4);
}

/** Signal 3 – Dictionary / domain-term hit rate (weight 0.25) */
function computeDictionaryHitRate(tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const unique = new Set(tokens.map((t) => t.toLowerCase().replace(/[^a-z]/g, '')).filter(Boolean));
  if (unique.size === 0) return 0;
  let hits = 0;
  for (const word of unique) {
    if (DOMAIN_TERMS.has(word)) hits++;
  }
  return hits / unique.size;
}

/** Signal 4 – Pages with usable text (weight 0.15) */
function computePagesWithTextRatio(pageTexts: string[]): number {
  if (pageTexts.length === 0) return 0;
  const usable = pageTexts.filter((p) => p.length > 50).length;
  return usable / pageTexts.length;
}

/** Signal 5 – Suspicious pattern rate (weight 0.15) */
function computeSuspiciousPatternRate(tokens: string[]): number {
  if (tokens.length === 0) return 0;

  // Regex patterns for suspicious tokens
  const punctuationSeq = /[^\w\s]{2,}/; // 2+ consecutive punctuation chars
  const singleCharRepeat = /^.$/; // single char token (flagged when repeated)
  const gibberishAlternating = /(?:[a-z]\d){2,}|(?:\d[a-z]){2,}/i; // letters-digits alternating
  const noAlpha = /^[^a-zA-Z]+$/; // token with zero alphabetic characters
  const mixedGibberish = /^[a-z]{1,2}\d|^\d[a-z]{1,2}$/i; // short alpha-digit combos like "h8f", "2k3j"
  const repeatedChar = /^(.)\1{2,}$/; // same character repeated 3+ times like "qqq", "xxxx"

  let suspicious = 0;

  // Detect repeated single-char tokens (look for runs of length >= 3)
  let singleCharRun = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

    if (punctuationSeq.test(t)) {
      suspicious++;
      singleCharRun = 0;
      continue;
    }
    if (gibberishAlternating.test(t)) {
      suspicious++;
      singleCharRun = 0;
      continue;
    }
    if (noAlpha.test(t)) {
      suspicious++;
      singleCharRun = 0;
      continue;
    }
    if (mixedGibberish.test(t)) {
      suspicious++;
      singleCharRun = 0;
      continue;
    }
    if (repeatedChar.test(t)) {
      suspicious++;
      singleCharRun = 0;
      continue;
    }

    // Track single-char runs
    if (singleCharRepeat.test(t)) {
      singleCharRun++;
      if (singleCharRun >= 3) {
        suspicious++;
      }
    } else {
      singleCharRun = 0;
    }
  }

  return suspicious / tokens.length;
}

// ---------------------------------------------------------------------------
// Main scorer
// ---------------------------------------------------------------------------

export function assessTextQuality(
  text: string,
  pageTexts: string[],
  source: 'native_extraction' | 'ocr_output',
): QualityAssessment {
  const tokens = text.split(/\s+/).filter(Boolean);

  const printable_ratio = computePrintableRatio(text);
  const avg_token_length = computeAvgTokenLengthScore(tokens);
  const dictionary_hit_rate = computeDictionaryHitRate(tokens);
  const pages_with_text_ratio = computePagesWithTextRatio(pageTexts);
  const suspicious_pattern_rate = computeSuspiciousPatternRate(tokens);

  const score =
    0.25 * printable_ratio +
    0.20 * avg_token_length +
    0.25 * dictionary_hit_rate +
    0.15 * pages_with_text_ratio +
    0.15 * (1.0 - suspicious_pattern_rate);

  // Clamp to [0, 1]
  const clampedScore = Math.max(0, Math.min(1, score));

  const tier: QualityAssessment['tier'] =
    clampedScore > 0.8 ? 'good' : clampedScore >= 0.4 ? 'partial' : 'poor';

  return {
    score: clampedScore,
    tier,
    source,
    signals: {
      printable_ratio,
      avg_token_length,
      dictionary_hit_rate,
      pages_with_text_ratio,
      suspicious_pattern_rate,
    },
  };
}
