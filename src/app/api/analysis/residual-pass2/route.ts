import { NextRequest, NextResponse } from 'next/server';
import sql from '@/lib/db';

/**
 * API endpoint: GET /api/analysis/residual-pass2
 * 
 * Analyzes remaining active Partial docs to identify residual exclusion patterns.
 * Returns data for the top 20 docs still affected by exclusion issues.
 */

interface ExcludedChunk {
  section_id: string;
  reason_code: string | null;
  inclusion_reason: string | null;
  payload: unknown;
}

async function classifyExclusionCategory(chunk: ExcludedChunk): Promise<string> {
  const code = chunk.reason_code ? String(chunk.reason_code).toLowerCase() : '';
  const inclusion = chunk.inclusion_reason ? String(chunk.inclusion_reason).toLowerCase() : '';

  if (code.includes('boilerplate') || inclusion?.includes('duplicate_boilerplate')) {
    return 'duplicate_boilerplate';
  }
  if (code.includes('ocr') || inclusion?.includes('ocr_garbage')) {
    return 'ocr_garbage';
  }
  if (code.includes('metadata') || inclusion?.includes('metadata')) {
    return 'metadata_block';
  }
  if (code.includes('broken') || inclusion?.includes('broken_structure')) {
    return 'broken_structure';
  }
  if (code.includes('short') && inclusion?.includes('noise')) {
    return 'short_fragment_noise';
  }
  if (code.includes('short') && inclusion?.includes('procedure')) {
    return 'short_procedure';
  }
  if (code.includes('table') && inclusion?.includes('reference')) {
    return 'table_reference';
  }
  if (code.includes('table') || inclusion?.includes('table_noise')) {
    return 'table_noise';
  }
  if (code.includes('list') || inclusion?.includes('list_reference')) {
    return 'list_reference';
  }
  if (code.includes('diagram') || code.includes('caption')) {
    return 'diagram_caption';
  }
  if (code.includes('footer') || inclusion?.includes('footer_mixed_body')) {
    return 'footer_mixed_body';
  }
  if (code.includes('weak')) {
    return 'weak_heading_fragment';
  }

  return 'other_exclusion';
}

async function analyzeExcludedChunks(
  docId: string
): Promise<{ patterns: Map<string, number>; sectionTypes: Map<string, number> }> {
  const patterns = new Map<string, number>();
  const sectionTypes = new Map<string, number>();

  const chunks = await sql<ExcludedChunk[]>`
    SELECT 
      c.id as section_id,
      c.normalisation_reason->'reason_code' as reason_code,
      c.normalisation_reason->'inclusion_reason' as inclusion_reason,
      c.normalisation_reason as payload,
      c.section_type
    FROM chunks c
    WHERE c.document_id = ${docId} AND c.retrieval_excluded = true
    ORDER BY c.id
  `;

  for (const chunk of chunks || []) {
    const category = await classifyExclusionCategory(chunk);
    patterns.set(category, (patterns.get(category) || 0) + 1);

    const sectionType = (chunk.payload as any)?.section_type || 'unknown';
    sectionTypes.set(sectionType, (sectionTypes.get(sectionType) || 0) + 1);
  }

  return { patterns, sectionTypes };
}

export async function GET(request: NextRequest) {
  try {
    // Query all active Partial docs
    const docs = await sql<any[]>`
      WITH chunk_counts AS (
        SELECT
          c.document_id,
          COUNT(*) FILTER (WHERE c.retrieval_excluded = false) as included_chunks,
          COUNT(*) FILTER (WHERE c.retrieval_excluded = true) as excluded_chunks,
          COUNT(*) as total_chunks
        FROM chunks c
        GROUP BY c.document_id
      )
      SELECT 
        d.id,
        d.title,
        d.source_type,
        d.is_active as active,
        d.text_quality_tier as quality_tier,
        d.quality_reasons,
        coalesce(cc.included_chunks, 0) as included_chunks,
        coalesce(cc.excluded_chunks, 0) as excluded_chunks,
        coalesce(cc.total_chunks, 0) as total_chunks
      FROM documents d
      LEFT JOIN chunk_counts cc ON d.id = cc.document_id
      WHERE d.is_active = true AND d.text_quality_tier = 'partial' AND d.quality_reasons IS NOT NULL
      HAVING coalesce(cc.total_chunks, 0) > 0
      ORDER BY 
        (coalesce(cc.excluded_chunks, 0)::float / NULLIF(coalesce(cc.total_chunks, 0), 0)) DESC,
        d.created_at DESC
      LIMIT 20
    `;

    const residualDocs: any[] = [];

    for (const doc of docs || []) {
      const totalChunks = parseInt(String(doc.total_chunks)) || 0;
      const excludedChunks = parseInt(String(doc.excluded_chunks)) || 0;
      const includedChunks = parseInt(String(doc.included_chunks)) || 0;
      const excludedRatio = totalChunks > 0 ? excludedChunks / totalChunks : 0;

      const { patterns, sectionTypes } = await analyzeExcludedChunks(doc.id);

      const patternArray = Array.from(patterns.entries())
        .map(([category, count]) => ({ category, count }))
        .sort((a, b) => b.count - a.count);

      const sectionTypeArray = Array.from(sectionTypes.entries())
        .map(([section_type, count]) => ({ section_type, count }))
        .sort((a, b) => b.count - a.count);

      const qualityReasons = doc.quality_reasons
        ? typeof doc.quality_reasons === 'string'
          ? JSON.parse(doc.quality_reasons)
          : doc.quality_reasons
        : [];

      const residualDrivers = [];
      if (qualityReasons.includes('High excluded chunk ratio')) {
        residualDrivers.push('High excluded chunk ratio');
      }
      const brokenCount = patternArray.find((p) => p.category === 'broken_structure')?.count || 0;
      if (brokenCount > 2) {
        residualDrivers.push('broken_structure');
      }
      const shortFragmentCount = patternArray.find((p) => p.category === 'short_fragment_noise')?.count || 0;
      if (shortFragmentCount > 3) {
        residualDrivers.push('short_fragment_noise');
      }
      if (residualDrivers.length === 0 && excludedRatio > 0.25) {
        residualDrivers.push('elevated_exclusion');
      }

      residualDocs.push({
        id: doc.id,
        title: doc.title,
        source_type: doc.source_type,
        total_chunks: totalChunks,
        included_chunks: includedChunks,
        excluded_chunks: excludedChunks,
        excluded_ratio: parseFloat(excludedRatio.toFixed(4)),
        active: doc.active,
        quality_tier: doc.quality_tier,
        quality_reasons: qualityReasons,
        dominant_exclusion_patterns: patternArray,
        residual_drivers: residualDrivers,
        section_type_breakdown: sectionTypeArray,
      });
    }

    // Aggregate category stats
    const categoryTotals = new Map<string, number>();
    for (const doc of residualDocs) {
      for (const pattern of doc.dominant_exclusion_patterns) {
        categoryTotals.set(pattern.category, (categoryTotals.get(pattern.category) || 0) + pattern.count);
      }
    }

    const categoryArray = Array.from(categoryTotals.entries())
      .map(([category, count]) => ({ category, excluded_chunks: count }))
      .sort((a, b) => b.excluded_chunks - a.excluded_chunks);

    // Identify residual patterns
    const residualPatterns = new Set<string>();
    for (const doc of residualDocs) {
      for (const driver of doc.residual_drivers) {
        residualPatterns.add(driver);
      }
    }

    // Category assessment
    const categoryAssessment: Record<string, any> = {};
    const trueNoise = ['duplicate_boilerplate', 'ocr_garbage', 'metadata_block', 'table_noise', 'short_fragment_noise'];
    const overExcluded = ['broken_structure', 'short_procedure', 'table_reference', 'list_reference', 'diagram_caption'];

    for (const { category } of categoryArray) {
      let assessment = { category, likely_issue: '', action_needed: false };

      if (trueNoise.includes(category)) {
        assessment.likely_issue = 'True noise - should remain excluded';
        assessment.action_needed = false;
      } else if (overExcluded.includes(category)) {
        const count = categoryTotals.get(category) || 0;
        if (count > 5) {
          assessment.likely_issue = 'Over-excluded - candidate for narrowed retention';
          assessment.action_needed = true;
        } else {
          assessment.likely_issue = 'Minor pattern - low impact tuning target';
          assessment.action_needed = false;
        }
      } else {
        assessment.likely_issue = 'Unclear - requires inspection';
        assessment.action_needed = false;
      }

      categoryAssessment[category] = assessment;
    }

    // Family drivers
    const familyMap = new Map<string, number>();
    for (const doc of residualDocs) {
      const family = doc.title.split(' ')[0] || 'unknown';
      familyMap.set(family, (familyMap.get(family) || 0) + 1);
    }

    const familyDrivers: Record<string, number> = {};
    for (const [family, count] of familyMap.entries()) {
      familyDrivers[family] = count;
    }

    const artifact = {
      generated_at: new Date().toISOString(),
      cohort_definition: 'Top 20 active Partial docs, prioritized by High excluded chunk ratio and high excluded ratio',
      cohort_size: residualDocs.length,
      per_document: residualDocs,
      top_exclusion_categories: categoryArray,
      residual_patterns_identified: Array.from(residualPatterns),
      summary: {
        avg_excluded_ratio: parseFloat(
          (residualDocs.reduce((sum, d) => sum + d.excluded_ratio, 0) / residualDocs.length).toFixed(4)
        ),
        high_excluded_doc_count: residualDocs.filter((d) => d.excluded_ratio >= 0.25).length,
        dominant_family_drivers: familyDrivers,
        category_assessment: categoryAssessment,
      },
    };

    return NextResponse.json(artifact);
  } catch (error) {
    console.error('[api/analysis/residual-pass2] Error:', error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
