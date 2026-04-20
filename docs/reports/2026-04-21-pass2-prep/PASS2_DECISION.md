# Pass 2 Decision Report: Accept Stable Floor

**Decision Date**: 2026-04-21  
**Status**: ✅ STABLE FLOOR ACHIEVED - RECOMMEND STOP

## Summary
Pass 2 analysis reveals a **stable floor at ~28% excluded ratio**. Attempting further structural extraction optimization is not recommended.

## Analysis Results

### Residual Pattern (Fixed Cohort: 20 docs)
- **Footer/header body mix present**: 17/20 docs (85%)
- **OCR contamination present**: 17/20 docs (85%)
- **Critical co-occurrence**: ALL 17 footer/header docs ALSO have OCR (100%)
- **Docs fixable by cleanup**: 0/20 (0%)
- **Stable floor risk**: 8/20 (40%)

### Root Cause Assessment
The 100% co-occurrence of footer/header contamination with OCR issues indicates:
- **Primary driver of exclusion**: OCR garbage/OCR-fallback text
- **Secondary issue**: Structural extraction is not the bottleneck
- **Pass 2 ROI**: Attempting footer/header cleanup without OCR fixes would yield <5% improvement (fails decision rule)

### Evidence Against Pass 2
1. **Decision rule not met**: Expected improvement <5% relative (required: ≥5%)
2. **Root cause mismatch**: Structural cleanup won't fix OCR-driven exclusion
3. **Risk/benefit**: 40% of docs may be inherently unfixable
4. **Time cost**: Implementation effort > marginal gains

## Pass 1 Achievement
- **Improvement**: 12.6% relative (0.3304 → 0.2888 avg excluded ratio)
- **Docs improved**: 13/20 (65%)
- **Techniques**: Heading cleanup, list recovery, table detection
- **Residual**: Primarily OCR + structural co-contamination

## Recommendation
✅ **STOP** - Accept 28% excluded ratio as the achievable floor for structural extraction.

### Next Steps (If Pursuing Further Improvement)
To go below 28% excluded ratio would require:
1. **OCR quality improvements**: Better OCR model or preprocessing
2. **OCR fallback strategy**: Detect and suppress OCR-only content
3. **Document selection**: Focus on native-text documents only
4. **New extraction pass**: Would be oriented to OCR handling, not structure

These are scope changes beyond the current extraction optimization cycle.

## Artifacts
- Analysis: `docs/reports/2026-04-21-pass2-prep/residual-pass2-detailed-analysis.json`
- Before (Pass 1): `docs/reports/2026-04-20-live-validation/structural-quality-analysis-before.json`
- After (Pass 1): `docs/reports/2026-04-20-live-validation/structural-quality-analysis-after.json`

## Test Status
- Current: 96/96 passing (from Pass 1)
- No new code changes made (per decision to stop)
- No regression risk

---
**Conclusion**: The extraction pipeline has reached a practical ceiling with pass 1 optimizations. Further improvement requires addressing OCR quality at the ingestion/preprocessing layer, not the extraction layer.
