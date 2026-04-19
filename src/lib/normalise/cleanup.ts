/**
 * Structural cleanup functions for normalised sections.
 * Task 6: merge tiny sections, drop empty headings, deduplicate, short content policy.
 */
import type { NormalisedSection } from '../types';
import { get_encoding } from 'tiktoken';

const enc = get_encoding('cl100k_base');

function countTokens(text: string): number {
  return enc.encode(text).length;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalise text for deduplication comparison: lowercase, trimmed, whitespace-collapsed. */
function normaliseText(text: string): string {
  return text.toLowerCase().trim().replace(/\s+/g, ' ');
}

function isStructuralHeadingLikeContent(content: string): boolean {
  const firstLine = (content ?? '').split('\n')[0]?.trim() ?? '';
  if (!firstLine) return false;

  // Numbered heading patterns like "13.2.1 MICROBIOLOGY TEST CODES" or "3 QUALITY CONTROL"
  if (/^\d+(\.\d+)*\s+\S/.test(firstLine)) return true;
  // Keyword heading patterns
  if (/^(appendix|table|figure|schedule|annex)\b/i.test(firstLine)) return true;

  return false;
}

/** Track the "current heading" while walking sections. */
function getCurrentHeading(sections: NormalisedSection[], index: number): string | null {
  for (let i = index - 1; i >= 0; i--) {
    if (sections[i].section_type === 'heading') {
      return sections[i].content;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 1. Merge adjacent tiny sections
// ---------------------------------------------------------------------------

export function mergeAdjacentTinySections(
  sections: NormalisedSection[],
  maxTokens: number = 50
): NormalisedSection[] {
  if (sections.length === 0) return [];

  const result: NormalisedSection[] = [];
  let i = 0;

  while (i < sections.length) {
    const current = { ...sections[i] };
    const currentHeading = getCurrentHeading(sections, i);
    const currentTokens = countTokens(current.content);

    // Try to merge with subsequent sections
    if (
      currentTokens < maxTokens &&
      current.section_type !== 'heading' &&
      !current.retrieval_excluded
    ) {
      const mergedIndices: number[] = [];
      let mergedContent = current.content;

      let j = i + 1;
      while (j < sections.length) {
        const next = sections[j];
        const nextHeading = getCurrentHeading(sections, j);
        const nextTokens = countTokens(next.content);

        // Stop conditions
        if (next.section_type === 'heading') break;
        if (nextTokens >= maxTokens) break;
        if (next.retrieval_excluded !== current.retrieval_excluded) break;
        if (nextHeading !== currentHeading) break;
        // Types that can merge with each other (prose-like content)
        const MERGEABLE_TYPES = new Set(['paragraph', 'instruction_block', 'procedure_step', 'note']);
        if (!MERGEABLE_TYPES.has(current.section_type) || !MERGEABLE_TYPES.has(next.section_type)) break;
        // Never merge across table or warning boundaries
        if (next.section_type === 'table' || next.section_type === 'warning') break;

        // Merge
        mergedContent = mergedContent + '\n\n' + next.content;
        mergedIndices.push(j);
        j++;

        // If accumulated content now exceeds the threshold, stop merging more
        if (countTokens(mergedContent) >= maxTokens) break;
      }

      if (mergedIndices.length > 0) {
        current.content = mergedContent;
        current.normalisation_reason = {
          merged_with: mergedIndices,
          reason: 'adjacent_small_sections',
        };
      }

      result.push(current);
      i = j;
    } else {
      result.push(current);
      i++;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// 2. Drop empty headings
// ---------------------------------------------------------------------------

export function dropEmptyHeadings(sections: NormalisedSection[]): NormalisedSection[] {
  // For each heading, determine if ALL child content is excluded.
  // A heading's children are sections between it and the next heading of same or higher level.
  const headingIndices: number[] = [];
  for (let i = 0; i < sections.length; i++) {
    if (sections[i].section_type === 'heading') {
      headingIndices.push(i);
    }
  }

  const emptyHeadingIndices = new Set<number>();

  for (const hi of headingIndices) {
    const headingLevel = sections[hi].level ?? 1;

    // Find child range: everything until next heading of same or higher level
    let end = sections.length;
    for (let j = hi + 1; j < sections.length; j++) {
      if (sections[j].section_type === 'heading') {
        const nextLevel = sections[j].level ?? 1;
        if (nextLevel <= headingLevel) {
          end = j;
          break;
        }
      }
    }

    // Check if there are any children at all
    const children = sections.slice(hi + 1, end).filter(s => s.section_type !== 'heading');
    if (children.length === 0) {
      // No content children — heading is empty
      emptyHeadingIndices.add(hi);
      continue;
    }

    // Check if all children are excluded
    const allExcluded = children.every(s => s.retrieval_excluded === true);
    if (allExcluded) {
      emptyHeadingIndices.add(hi);
    }
  }

  return sections.filter((_, i) => !emptyHeadingIndices.has(i));
}

// ---------------------------------------------------------------------------
// 3. Deduplicate within a document
// ---------------------------------------------------------------------------

const NEVER_DEDUP_TYPES = new Set(['procedure_step', 'instruction_block', 'warning']);

export function deduplicateWithinDocument(sections: NormalisedSection[]): NormalisedSection[] {
  // Key: normalised text + section_type + parent heading
  const seen = new Map<string, number>(); // key -> first occurrence index

  return sections.map((section, i) => {
    if (NEVER_DEDUP_TYPES.has(section.section_type)) return section;
    if (section.section_type === 'heading') return section;
    if (section.retrieval_excluded) return section;

    const heading = getCurrentHeading(sections, i);
    const key = `${normaliseText(section.content)}||${section.section_type}||${heading ?? ''}`;

    const firstIndex = seen.get(key);
    if (firstIndex !== undefined) {
      // Duplicate — mark excluded
      return {
        ...section,
        retrieval_excluded: true,
        normalisation_reason: {
          excluded: true,
          reason: 'duplicate_within_document',
          kept_index: firstIndex,
        },
      };
    }

    seen.set(key, i);
    return section;
  });
}

// ---------------------------------------------------------------------------
// 4. Short content policy
// ---------------------------------------------------------------------------

const SHORT_EXEMPT_TYPES = new Set([
  'table',
  'procedure_step',
  'instruction_block',
  'warning',
  'note',
  'appendix',   // Appendix chunks are structurally important even when short (tables, codes)
]);

export function applyShortContentPolicy(sections: NormalisedSection[]): NormalisedSection[] {
  const MIN_TOKENS = 20;

  return sections.map((section, i) => {
    if (section.retrieval_excluded) return section;
    if (section.section_type === 'heading') return section;
    if (SHORT_EXEMPT_TYPES.has(section.section_type)) return section;
    if (isStructuralHeadingLikeContent(section.content)) return section;

    const tokens = countTokens(section.content);
    if (tokens >= MIN_TOKENS) return section;

    // Check if adjacent to a section with the same parent heading that is > 20 tokens
    const heading = getCurrentHeading(sections, i);

    const isIsolated = !sections.some((other, j) => {
      if (j === i) return false;
      if (Math.abs(j - i) > 1) return false; // only adjacent
      if (other.section_type === 'heading') return false;
      if (other.retrieval_excluded) return false;
      const otherHeading = getCurrentHeading(sections, j);
      if (otherHeading !== heading) return false;
      return countTokens(other.content) >= MIN_TOKENS;
    });

    if (!isIsolated) return section;

    return {
      ...section,
      retrieval_excluded: true,
      normalisation_reason: {
        excluded: true,
        reason: 'short_content_isolated',
      },
    };
  });
}
