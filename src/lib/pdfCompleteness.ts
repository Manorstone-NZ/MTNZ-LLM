export type PdfAuditRisk = 'low' | 'medium' | 'high';

export interface PdfAuditDocInput {
  title: string;
  source_path: string;
  extraction_method: string | null;
  text_quality_tier: 'good' | 'partial' | 'poor' | null;
  text_quality_score: number | null;
  needs_review: boolean;
  quarantined: boolean;
  chunk_count: number;
}

export interface PdfAuditChunkInput {
  page_number: number | null;
  section_title: string | null;
  content: string;
}

export interface PdfAuditResult {
  title: string;
  source_path: string;
  extraction_method: string | null;
  text_quality_tier: 'good' | 'partial' | 'poor' | null;
  text_quality_score: number | null;
  chunk_count: number;
  pages_seen: number;
  extracted_char_count: number;
  heading_count: number;
  numbered_headings_found: string[];
  appendix_references: string[];
  missing_referenced_appendices: string[];
  pages_with_no_chunks_estimate: number;
  avg_chars_per_chunk: number;
  risk_score: number;
  risk: PdfAuditRisk;
  reasons: string[];
}

const SECTION_REGEX = /\b(\d{1,2}(?:\.\d{1,3}){0,3})\b/g;
// Focus on hierarchical appendix refs (e.g. 13.2, 13.2.1) to reduce false positives like "Appendix 2".
const APPENDIX_REF_REGEX = /\bappendix\s+([A-Z]?\d+\.\d+(?:\.\d+){0,3})\b/gi;

function isLikelyTableOfContentsChunk(chunk: PdfAuditChunkInput): boolean {
  const section = (chunk.section_title ?? '').toLowerCase();
  const content = (chunk.content ?? '').toLowerCase();

  if (section.includes('table of contents') || content.includes('table of contents')) return true;

  // Dot-leader TOC rows like "17.2 Foo .... 101"
  if (/\.{4,}\s*\d+/.test(chunk.content ?? '')) return true;

  return false;
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function toRisk(score: number): PdfAuditRisk {
  if (score >= 7) return 'high';
  if (score >= 4) return 'medium';
  return 'low';
}

function detectMissingAppendices(
  appendixReferences: string[],
  appendixReferenceCounts: Record<string, number>,
  chunks: PdfAuditChunkInput[],
): string[] {
  const lowerCorpus = chunks
    .map((chunk) => `${chunk.section_title ?? ''}\n${chunk.content ?? ''}`)
    .join('\n')
    .toLowerCase();

  // Build a set of section_titles that look like appendix headings (e.g., "13.2.1 MICROBIOLOGY TEST CODES")
  // These represent appendix content even when the body text doesn't repeat "appendix X.Y"
  const sectionHeadings = new Set(
    chunks
      .map((c) => (c.section_title ?? '').toLowerCase().trim())
      .filter((t) => t.length > 0),
  );

  return appendixReferences.filter((ref) => {
    const refLower = ref.toLowerCase();
    const mentionCount = appendixReferenceCounts[refLower] ?? 0;

    // Check if any section_title starts with this appendix number followed by space or tab
    // e.g., ref="13.2.1" → matches section_title "13.2.1 microbiology test codes"
    const hasHeading = Array.from(sectionHeadings).some(
      (h) => h.startsWith(refLower + ' ') || h.startsWith(refLower + '\t') || h === refLower,
    );
    if (hasHeading) return false;

      // Also check if any section_title represents a child section of this ref.
      // e.g., ref="13.2" is considered present if "13.2.1 microbiology test codes" heading exists.
      const hasChildHeading = Array.from(sectionHeadings).some(
        (h) => h.startsWith(refLower + '.'),
      );
      if (hasChildHeading) return false;

      // For refs that appear only once, avoid false positives when the surrounding
      // section family clearly exists (e.g. 17.1, 17.3, 17.8 present but 17.2 cited once).
      const majorPrefix = refLower.split('.')[0];
      const hasSiblingHeadings = Array.from(sectionHeadings).some(
        (h) => h.startsWith(majorPrefix + '.') && !h.startsWith(refLower + ' '),
      );
      if (mentionCount <= 1 && hasSiblingHeadings) return false;

    // Fall back to checking for "appendix ref" appearing at least twice in body text
    const marker = `appendix ${refLower}`;
    const firstHit = lowerCorpus.indexOf(marker);
    if (firstHit === -1) {
      return true;
    }

    // If appendix marker appears only once, assume the content is missing and only referenced.
    const secondHit = lowerCorpus.indexOf(marker, firstHit + marker.length);
    if (secondHit === -1) {
      return true;
    }

    return false;
  });
}

export function auditPdfCompleteness(
  doc: PdfAuditDocInput,
  chunks: PdfAuditChunkInput[],
): PdfAuditResult {
  const pagesSeenSet = new Set<number>();
  const pagesWithChunksSet = new Set<number>();
  const headings: string[] = [];
  const sectionHits: string[] = [];
  const appendixRefs: string[] = [];
  const appendixRefCounts: Record<string, number> = {};
  let extractedChars = 0;

  for (const chunk of chunks) {
    const content = chunk.content ?? '';
    extractedChars += content.length;

    if (chunk.page_number !== null && Number.isFinite(chunk.page_number)) {
      pagesSeenSet.add(chunk.page_number);
      pagesWithChunksSet.add(chunk.page_number);
    }

    if (chunk.section_title && chunk.section_title.trim()) {
      headings.push(chunk.section_title.trim());
      const headingSections = chunk.section_title.match(SECTION_REGEX) ?? [];
      sectionHits.push(...headingSections);
    }

    const contentSections = content.match(SECTION_REGEX) ?? [];
    sectionHits.push(...contentSections);

    if (!isLikelyTableOfContentsChunk(chunk)) {
      let match: RegExpExecArray | null;
      while ((match = APPENDIX_REF_REGEX.exec(content)) !== null) {
        appendixRefs.push(match[1]);
        const key = String(match[1]).toLowerCase();
        appendixRefCounts[key] = (appendixRefCounts[key] ?? 0) + 1;
      }
    }
  }

  const numberedHeadings = unique(sectionHits).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
  const appendixReferences = unique(appendixRefs).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
  const missingAppendices = detectMissingAppendices(appendixReferences, appendixRefCounts, chunks);

  const pagesSeen = pagesSeenSet.size;
  const pagesWithChunks = pagesWithChunksSet.size;
  const pagesWithoutChunksEstimate = Math.max(0, pagesSeen - pagesWithChunks);
  const avgCharsPerChunk = doc.chunk_count > 0 ? Math.round(extractedChars / doc.chunk_count) : 0;

  const reasons: string[] = [];
  let riskScore = 0;

  if (doc.quarantined) {
    riskScore += 8;
    reasons.push('Document is quarantined');
  }
  if (doc.needs_review) {
    riskScore += 2;
    reasons.push('Document is marked needs_review');
  }
  if (doc.text_quality_tier === 'poor') {
    riskScore += 4;
    reasons.push('Text quality tier is poor');
  }
  if (doc.text_quality_tier === 'partial') {
    riskScore += 1;
    reasons.push('Text quality tier is partial');
  }
  if (doc.chunk_count <= 5) {
    riskScore += 2;
    reasons.push('Very low chunk count');
  }
  if (avgCharsPerChunk < 220) {
    riskScore += 1;
    reasons.push('Low average characters per chunk');
  }
  if (missingAppendices.length > 0) {
    riskScore += 4;
    reasons.push(`Missing appendix content for refs: ${missingAppendices.join(', ')}`);
  }
  if (numberedHeadings.length < 8 && doc.chunk_count > 40) {
    riskScore += 1;
    reasons.push('Low numbered-section detection compared to chunk volume');
  }
  if (pagesWithoutChunksEstimate > 0) {
    riskScore += 1;
    reasons.push('Pages without chunk coverage detected');
  }

  return {
    title: doc.title,
    source_path: doc.source_path,
    extraction_method: doc.extraction_method,
    text_quality_tier: doc.text_quality_tier,
    text_quality_score: doc.text_quality_score,
    chunk_count: doc.chunk_count,
    pages_seen: pagesSeen,
    extracted_char_count: extractedChars,
    heading_count: unique(headings).length,
    numbered_headings_found: numberedHeadings.slice(0, 120),
    appendix_references: appendixReferences,
    missing_referenced_appendices: missingAppendices,
    pages_with_no_chunks_estimate: pagesWithoutChunksEstimate,
    avg_chars_per_chunk: avgCharsPerChunk,
    risk_score: riskScore,
    risk: toRisk(riskScore),
    reasons,
  };
}
