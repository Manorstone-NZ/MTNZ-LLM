import { createHash } from 'crypto';
import sql from '../db';
import type { NormalisedSection } from '../types';

// ============================================================
// 1. Rule-based pattern matching
// ============================================================

const RULE_PATTERNS: { pattern: RegExp; label: string }[] = [
  // Watermarks / controlled copy
  { pattern: /CONTROLLED COPY IF THIS LINE IS GREEN/i, label: 'CONTROLLED_COPY' },
  { pattern: /THIS DOCUMENT IS UNCONTROLLED/i, label: 'UNCONTROLLED_DOC' },

  // Page numbers
  { pattern: /^\s*(?:Page\s+)?\d+\s*(?:of\s+\d+)?\s*$/i, label: 'PAGE_NUMBER' },

  // PPE / H&S boilerplate phrases
  { pattern: /wear PPE/i, label: 'PPE_BLOCK' },
  { pattern: /wash hands/i, label: 'PPE_BLOCK' },
  { pattern: /wipe down frequently/i, label: 'PPE_BLOCK' },
  { pattern: /standing for prolonged periods/i, label: 'PPE_BLOCK' },
  { pattern: /heavy lifting/i, label: 'PPE_BLOCK' },
  { pattern: /wear suitable footwear/i, label: 'PPE_BLOCK' },
  { pattern: /take micro\s?pauses/i, label: 'PPE_BLOCK' },
  { pattern: /use seating when appropriate/i, label: 'PPE_BLOCK' },
  { pattern: /handling chemicals/i, label: 'PPE_BLOCK' },
  { pattern: /clean minor spills/i, label: 'PPE_BLOCK' },
  { pattern: /working alone in the laboratory/i, label: 'PPE_BLOCK' },

  // TITAN export header
  { pattern: /^Name,Account Number,Account Manager,Client Type/, label: 'TITAN_EXPORT_HEADER' },

  // Generic revision patterns
  { pattern: /^Version,Date,Author/i, label: 'REVISION_TABLE_HEADER' },
  { pattern: /^Rev,Date,Description/i, label: 'REVISION_TABLE_HEADER' },
];

export function isRuleBasedBoilerplate(
  content: string,
): { matched: boolean; pattern?: string } {
  for (const { pattern, label } of RULE_PATTERNS) {
    if (pattern.test(content)) {
      return { matched: true, pattern: label };
    }
  }
  return { matched: false };
}

// ============================================================
// 2. Protected content check (HARD OVERRIDE)
// ============================================================

const PROTECTED_PATTERNS: RegExp[] = [
  // Temperature constraints
  /\d+\s*°[CF]/,

  // Time with numbers
  /\d+\s*(hours?|hrs?|minutes?|mins?|seconds?|secs?|days?)\b/i,

  // Concentrations
  /\d+\s*(mg\/[Ll]|ppm|%|g\/[Ll]|µg|μg|mL|ml|ng)/,

  // Equipment identifiers — known brand/instrument names
  /milkoscan|bactoscan|combifoss|cryoscope|fossomatic|agilent|gerber/i,
  // Model numbers (e.g. FT-120, MPA3000)
  /\b[A-Z]{2,4}[\s-]?\d{3,5}\b/,

  // Test codes / method IDs
  /\bLOP-[A-Z]{2}\s*\d{3}/i,
  /\bEOP\s*\d{3}/i,

  // Chemical / biological terms
  /bovis|mycoplasma|escherichia|coli|lactam|aflatoxin|coliform|thermoduric|somatic\s+cell/i,

  // Measurable conditions (action + preposition + number)
  /(incubate|centrifuge|hold|heat|cool|maintain|store)\s+(at|to|for)\s+\d/i,
];

export function isProtectedContent(content: string): boolean {
  return PROTECTED_PATTERNS.some((p) => p.test(content));
}

// ============================================================
// 3. Corpus fingerprinting
// ============================================================

/**
 * Normalise text for hashing: lowercase, collapse whitespace, strip dates,
 * page references, and version stamps. Then SHA-256.
 */
export function computeBoilerplateHash(content: string): string {
  let normalised = content.toLowerCase();

  // Strip dates: dd/mm/yyyy, yyyy-mm-dd
  normalised = normalised.replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, '');
  normalised = normalised.replace(/\b\d{4}-\d{2}-\d{2}\b/g, '');

  // Strip page references: "page N", "p.N", "p N"
  normalised = normalised.replace(/\b(?:page|p\.?)\s*\d+/gi, '');

  // Strip version stamps: "vN", "version N"
  normalised = normalised.replace(/\b(?:v|version)\s*\d+/gi, '');

  // Collapse whitespace
  normalised = normalised.replace(/\s+/g, ' ').trim();

  return createHash('sha256').update(normalised).digest('hex');
}

export async function getFingerprint(
  hash: string,
): Promise<{ count: number; confirmed: boolean } | null> {
  const rows = await sql`
    SELECT occurrence_count, is_confirmed_boilerplate
    FROM boilerplate_fingerprints
    WHERE hash = ${hash}
  `;
  if (rows.length === 0) return null;
  return {
    count: rows[0].occurrence_count as number,
    confirmed: rows[0].is_confirmed_boilerplate as boolean,
  };
}

export async function updateFingerprint(
  hash: string,
  sampleText: string,
): Promise<void> {
  const sample = sampleText.slice(0, 200);
  await sql`
    INSERT INTO boilerplate_fingerprints (hash, sample_text, occurrence_count, last_seen_at)
    VALUES (${hash}, ${sample}, 1, now())
    ON CONFLICT (hash) DO UPDATE SET
      occurrence_count = boilerplate_fingerprints.occurrence_count + 1,
      last_seen_at = now(),
      sample_text = COALESCE(boilerplate_fingerprints.sample_text, ${sample})
  `;
}

// ============================================================
// 4. Combined suppression function
// ============================================================

/** Domain-specific terms that indicate high-information content. */
const DOMAIN_TERMS =
  /milkoscan|bactoscan|combifoss|cryoscope|fossomatic|agilent|gerber|somatic\s+cell|coliform|thermoduric|lactam|aflatoxin|bovis|mycoplasma|escherichia|coli|incubat|centrifug|pipett|calibrat|aseptic|pasteuris|homogenis|titrat|inoculat/i;

function isLowInformation(content: string): boolean {
  const words = content
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const uniqueWords = new Set(words);

  if (uniqueWords.size >= 10) return false;
  if (DOMAIN_TERMS.test(content)) return false;

  return true;
}

export async function suppressBoilerplate(
  sections: NormalisedSection[],
  mode: 'rebuild' | 'incremental',
): Promise<NormalisedSection[]> {
  const result: NormalisedSection[] = [];

  for (const section of sections) {
    // Skip sections already classified as footer_header or form_stub
    if (
      section.section_type === 'footer_header' ||
      section.section_type === 'form_stub'
    ) {
      result.push(section);
      continue;
    }

    const content = section.content ?? '';

    // Step 1: compute hash
    const hash = computeBoilerplateHash(content);

    // Step 2: always update fingerprint count
    await updateFingerprint(hash, content);

    // Step 3: protected content check (HARD OVERRIDE)
    const protectedHit = isProtectedContent(content);
    if (protectedHit) {
      result.push({
        ...section,
        boilerplate_hash: hash,
        normalisation_reason: {
          classification: section.section_type,
          protected: true,
          reason: 'contains_protected_content',
        },
      });
      continue;
    }

    // Step 4: rule-based pattern check
    const ruleResult = isRuleBasedBoilerplate(content);
    if (ruleResult.matched) {
      result.push({
        ...section,
        is_boilerplate: true,
        retrieval_excluded: true,
        section_type: 'boilerplate',
        boilerplate_hash: hash,
        normalisation_reason: {
          excluded: true,
          reason: 'rule_pattern',
          pattern: ruleResult.pattern,
        },
      });
      continue;
    }

    // Step 5: corpus fingerprint check (rebuild mode only)
    if (mode === 'rebuild') {
      const fp = await getFingerprint(hash);
      if (fp && fp.count >= 20 && isLowInformation(content)) {
        result.push({
          ...section,
          is_boilerplate: true,
          retrieval_excluded: true,
          section_type: 'boilerplate',
          boilerplate_hash: hash,
          normalisation_reason: {
            excluded: true,
            reason: 'corpus_frequency',
            occurrence_count: fp.count,
            confirmed: fp.confirmed,
          },
        });
        continue;
      }
    }

    // Step 6: no suppression — pass through with hash attached
    result.push({
      ...section,
      boilerplate_hash: hash,
    });
  }

  return result;
}
