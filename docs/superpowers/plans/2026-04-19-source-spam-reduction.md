# Source Spam Reduction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce 28-source outliers to <20 while maintaining answer quality through tiered scoring, hard caps, and quality-aware selection.

**Architecture:** Strengthen scoring with entity-pair detection and integration signals. Implement dual-cap selection (hard total cap + per-doc cap) with tier-aware guarantees (preserve Tier 1 chunks and mechanism signals). Add diagnostic output to validation.

**Tech Stack:** TypeScript, existing retrieval.ts scoring + new unit tests

---

## File Structure

- **Modify:** `src/lib/retrieval.ts` (lines 150-250)
  - Add tiered scoring with entity-pair detection
  - Refactor `pickInteractionResults` with dual-cap selection
  - Add diagnostic metadata to results

- **Create:** `src/lib/retrieval.interaction-selection.test.ts`
  - Unit tests for tier classification
  - Tests for cap enforcement
  - Tests for guarantee preservation

- **Modify:** `scripts/test-golden-queries.ts` or new `scripts/validate-interaction-diagnostics.ts`
  - Add diagnostic output for interaction queries (source count, tier counts, doc count)

---

## Task 1: Strengthen Scoring with Tiered Entity Detection

**Files:**
- Modify: `src/lib/retrieval.ts` lines 150-200

**Goal:** Build scored candidates with tier assignment and entity-pair signals

- [ ] **Step 1: Define tiering constants and metrics**

Add after line 146 (after `entityMentioned` function):

```typescript
// Tier classification for interaction results
type InteractionTier = 'tier1_both_entities' | 'tier2_integrated' | 'tier3_supporting';

interface ScoredInteractionChunk extends ScoredChunk {
  interactionTier: InteractionTier;
  hasBothEntities: boolean;
  hasIntegrationSignal: boolean;
  hasTransferVerb: boolean;
  hasSetupSignal: boolean;
}

function classifyInteractionTier(
  chunk: ScoredChunk,
  corpus: string,
  systemA?: string,
  systemB?: string,
): {
  tier: InteractionTier;
  hasBothEntities: boolean;
  hasIntegrationSignal: boolean;
  hasTransferVerb: boolean;
  hasSetupSignal: boolean;
} {
  const hasA = entityMentioned(corpus, systemA);
  const hasB = entityMentioned(corpus, systemB);
  const hasIntegration = INTERACTION_CONTENT_REGEX.test(corpus);
  const hasTransfer = INTERACTION_TRANSFER_VERB_REGEX.test(corpus);
  const hasSetup = INTERACTION_SETUP_SECTION_REGEX.test(chunk.section_title ?? '');

  if (hasA && hasB) {
    return {
      tier: 'tier1_both_entities',
      hasBothEntities: true,
      hasIntegrationSignal: hasIntegration,
      hasTransferVerb: hasTransfer,
      hasSetupSignal: hasSetup,
    };
  }

  if (hasIntegration && (hasA || hasB)) {
    return {
      tier: 'tier2_integrated',
      hasBothEntities: false,
      hasIntegrationSignal: hasIntegration,
      hasTransferVerb: hasTransfer,
      hasSetupSignal: hasSetup,
    };
  }

  return {
    tier: 'tier3_supporting',
    hasBothEntities: false,
    hasIntegrationSignal: hasIntegration,
    hasTransferVerb: hasTransfer,
    hasSetupSignal: hasSetup,
  };
}
```

- [ ] **Step 2: Add tier-aware scoring bonus function**

Add after `classifyInteractionTier`:

```typescript
function computeTierScoreBonus(
  tier: InteractionTier,
  hasTransfer: boolean,
  hasSetup: boolean,
  baseScore: number,
): number {
  let boost = 1.0;

  if (tier === 'tier1_both_entities') {
    boost *= 1.4; // Strong relevance for dual-entity chunks
  } else if (tier === 'tier2_integrated') {
    boost *= 1.15; // Moderate boost for integrated signal
  }
  // tier3_supporting gets no boost

  if (hasTransfer) {
    boost *= 1.12; // Transfer verbs indicate active flow
  }

  if (hasSetup) {
    boost *= 1.08; // Setup/config sections are mechanism indicators
  }

  return baseScore * boost;
}
```

- [ ] **Step 3: Run tests to ensure new functions compile**

```bash
npm run build 2>&1 | head -20
```

Expected: No compilation errors in retrieval.ts

- [ ] **Step 4: Commit**

```bash
git add src/lib/retrieval.ts
git commit -m "feat(retrieval): add tier classification and scoring functions for interaction results"
```

---

## Task 2: Refactor `pickInteractionResults` with Dual-Cap Selection

**Files:**
- Modify: `src/lib/retrieval.ts` lines 150-200 (the `pickInteractionResults` function)

**Goal:** Enforce hard total cap + per-doc cap + tier guarantees + diagnostic metadata

- [ ] **Step 1: Add constants for interaction caps**

Update environment variable parsing (around line 251):

```typescript
// Interaction mode: wide candidate pool, tighter final set with tiered source selection.
const interactionTopK = parseInt(process.env.INTERACTION_TOP_K_CANDIDATES || '40', 10);
const interactionTopKFinal = parseInt(process.env.INTERACTION_TOP_K_FINAL || '18', 10);
const interactionMaxPerDoc = parseInt(process.env.INTERACTION_MAX_PER_DOC || '3', 10); // Reduced from 4 to 3
const interactionMaxLowSignal = parseInt(process.env.INTERACTION_MAX_LOW_SIGNAL || '2', 10);
const interactionHardCap = parseInt(process.env.INTERACTION_HARD_CAP || '20', 10); // New: hard total cap
```

- [ ] **Step 2: Replace `pickInteractionResults` implementation**

Replace the entire function (lines ~150-200) with:

```typescript
interface InteractionSelectionResult {
  selected: ScoredChunk[];
  diagnostics: {
    totalSources: number;
    tier1Count: number;
    tier2Count: number;
    tier3Count: number;
    uniqueDocCount: number;
  };
}

function pickInteractionResults(
  ranked: ScoredChunk[],
  targetCount: number,
  maxPerDocument: number,
  maxLowSignal: number,
  systemA?: string,
  systemB?: string,
): InteractionSelectionResult {
  const hardCap = 20; // Hard total cap to prevent spam
  const selected: ScoredChunk[] = [];
  const perDocCount = new Map<string, number>();
  const uniqueDocs = new Set<string>();

  let tier1Count = 0;
  let tier2Count = 0;
  let tier3Count = 0;

  // Score and classify all candidates
  const classified: Array<{
    chunk: ScoredChunk;
    tier: InteractionTier;
    hasBothEntities: boolean;
    hasIntegrationSignal: boolean;
    hasTransferVerb: boolean;
    hasSetupSignal: boolean;
    tierScore: number;
  }> = [];

  for (const chunk of ranked) {
    const corpus = `${chunk.section_title ?? ''} ${chunk.content_preview ?? ''} ${chunk.content ?? ''}`;
    const tierInfo = classifyInteractionTier(chunk, corpus, systemA, systemB);
    const tierScore = computeTierScoreBonus(
      tierInfo.tier,
      tierInfo.hasTransferVerb,
      tierInfo.hasSetupSignal,
      chunk.score,
    );

    classified.push({
      chunk,
      tier: tierInfo.tier,
      hasBothEntities: tierInfo.hasBothEntities,
      hasIntegrationSignal: tierInfo.hasIntegrationSignal,
      hasTransferVerb: tierInfo.hasTransferVerb,
      hasSetupSignal: tierInfo.hasSetupSignal,
      tierScore,
    });
  }

  // Sort by tier first, then by tierScore
  const tierOrder = {
    tier1_both_entities: 0,
    tier2_integrated: 1,
    tier3_supporting: 2,
  };

  classified.sort((a, b) => {
    const tierDiff = tierOrder[a.tier] - tierOrder[b.tier];
    if (tierDiff !== 0) return tierDiff;
    return b.tierScore - a.tierScore;
  });

  // First pass: guarantee at least 1-2 Tier 1 chunks if available
  let tier1Collected = 0;
  const tier1Limit = 2;
  for (const item of classified) {
    if (item.tier !== 'tier1_both_entities') break;
    if (tier1Collected >= tier1Limit) break;
    if (selected.length >= hardCap) break;

    const docCurrent = perDocCount.get(item.chunk.document_id) ?? 0;
    if (docCurrent < maxPerDocument) {
      selected.push(item.chunk);
      perDocCount.set(item.chunk.document_id, docCurrent + 1);
      uniqueDocs.add(item.chunk.document_id);
      tier1Count += 1;
      tier1Collected += 1;
    }
  }

  // Second pass: collect Tier 2 + ensure at least 1 mechanism chunk
  let mechanismChunkFound = false;
  for (const item of classified) {
    if (item.tier === 'tier1_both_entities') continue; // Already collected
    if (selected.length >= hardCap) break;

    const docCurrent = perDocCount.get(item.chunk.document_id) ?? 0;
    if (docCurrent < maxPerDocument) {
      const isMechanism = item.hasIntegrationSignal || item.hasSetupSignal;

      // Prioritize mechanism chunks if not yet found
      if (!mechanismChunkFound && isMechanism) {
        selected.push(item.chunk);
        perDocCount.set(item.chunk.document_id, docCurrent + 1);
        uniqueDocs.add(item.chunk.document_id);
        if (item.tier === 'tier2_integrated') tier2Count += 1;
        else tier3Count += 1;
        mechanismChunkFound = true;
      }
    }
  }

  // Third pass: fill remaining slots, respecting tier order and caps
  for (const item of classified) {
    if (selected.length >= hardCap) break;
    if (selected.some((s) => s.id === item.chunk.id)) continue; // Already selected

    const docCurrent = perDocCount.get(item.chunk.document_id) ?? 0;
    if (docCurrent < maxPerDocument) {
      selected.push(item.chunk);
      perDocCount.set(item.chunk.document_id, docCurrent + 1);
      uniqueDocs.add(item.chunk.document_id);
      if (item.tier === 'tier1_both_entities') tier1Count += 1;
      else if (item.tier === 'tier2_integrated') tier2Count += 1;
      else tier3Count += 1;
    }
  }

  return {
    selected,
    diagnostics: {
      totalSources: selected.length,
      tier1Count,
      tier2Count,
      tier3Count,
      uniqueDocCount: uniqueDocs.size,
    },
  };
}
```

- [ ] **Step 3: Update the call site in `hybridSearchWithMode`**

Around line 500, update the interaction selection call:

```typescript
if (mode === 'interaction') {
  const result = pickInteractionResults(
    results,
    interactionCap,
    interactionMaxPerDoc,
    interactionMaxLowSignal,
    interactionPair?.systemA,
    interactionPair?.systemB,
  );

  // Log diagnostics for debugging/tuning
  console.log(
    `[interaction-retrieval] tier distribution: Tier1=${result.diagnostics.tier1Count}, Tier2=${result.diagnostics.tier2Count}, Tier3=${result.diagnostics.tier3Count}, total=${result.diagnostics.totalSources}, docs=${result.diagnostics.uniqueDocCount}`,
  );

  if (result.selected.length > 0) {
    return result.selected;
  }

  // ... rest of fallback path
}
```

- [ ] **Step 4: Run build and type check**

```bash
npm run build 2>&1 | head -30
```

Expected: No errors or type mismatches

- [ ] **Step 5: Commit**

```bash
git add src/lib/retrieval.ts
git commit -m "refactor(retrieval): implement dual-cap selection with tier guarantees for interaction results"
```

---

## Task 3: Add Unit Tests for Interaction Selection

**Files:**
- Create: `src/lib/retrieval.interaction-selection.test.ts`

**Goal:** Verify tier classification, cap enforcement, and quality preservation

- [ ] **Step 1: Create test file with tier classification tests**

```typescript
import { describe, it, expect } from '@jest/globals';
import type { ScoredChunk } from './types';

// Mock functions exported from retrieval.ts for testing
// In actual code, export classifyInteractionTier and computeTierScoreBonus

describe('Interaction Selection', () => {
  describe('Tier Classification', () => {
    it('should classify chunks with both entities as Tier 1', () => {
      // Test case: chunk mentions both system A and system B
      const corpus = 'MADCAP sends results to sorter automatically';
      // Expected: tier1_both_entities
    });

    it('should classify integration signal + single entity as Tier 2', () => {
      // Test case: chunk mentions integration but only one system
      const corpus = 'The web service integrates with MADCAP via API';
      // Expected: tier2_integrated
    });

    it('should classify generic boilerplate as Tier 3', () => {
      // Test case: no entities, no integration signal
      const corpus = 'This system processes data and generates reports';
      // Expected: tier3_supporting
    });
  });

  describe('Cap Enforcement', () => {
    it('should not exceed hard total cap of 20 sources', () => {
      // Create 30 mock chunks
      // Run pickInteractionResults
      // Assert result.selected.length <= 20
    });

    it('should not exceed per-document cap of 3', () => {
      // Create mock chunks with multiple from same doc
      // Assert no document has >3 chunks in result
    });

    it('should preserve at least 1 Tier 1 chunk if available', () => {
      // Create ranked list with Tier 1 and Tier 3 chunks
      // Assert at least 1 Tier 1 in result
    });

    it('should preserve mechanism/config chunks', () => {
      // Create ranked list with integration signal chunks
      // Assert at least 1 has integration signal
    });
  });

  describe('Tier Scoring Bonus', () => {
    it('should boost Tier 1 chunks significantly (1.4x)', () => {
      // Verify computeTierScoreBonus('tier1_both_entities', ...) multiplier
    });

    it('should boost Tier 2 with transfer verbs (1.15x + 1.12x)', () => {
      // Verify cumulative boost for tier2 + transfer verb
    });

    it('should not boost Tier 3 generic chunks', () => {
      // Verify tier3_supporting gets minimal boost
    });
  });
});
```

- [ ] **Step 2: Export tier classification and scoring functions for testing**

Update `src/lib/retrieval.ts` to export:

```typescript
export { classifyInteractionTier, computeTierScoreBonus };
```

- [ ] **Step 3: Implement full test cases**

Fill in the mock data and assertions for each test. Use representative `ScoredChunk` objects.

- [ ] **Step 4: Run tests**

```bash
npm test src/lib/retrieval.interaction-selection.test.ts 2>&1
```

Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/lib/retrieval.interaction-selection.test.ts
git commit -m "test(retrieval): add unit tests for interaction tier classification and cap enforcement"
```

---

## Task 4: Add Diagnostic Output to Validation

**Files:**
- Modify or create: `scripts/validate-interaction-diagnostics.ts` (or add to existing test harness)

**Goal:** Show tier distribution and source counts for each interaction query

- [ ] **Step 1: Create diagnostic validation script**

```typescript
// scripts/validate-interaction-diagnostics.ts
import { hybridSearchWithMode } from '../src/lib/retrieval';
import type { RetrievalOptions } from '../src/lib/retrieval';

interface InteractionTest {
  query: string;
  systemA: string;
  systemB: string;
}

const testCases: InteractionTest[] = [
  {
    query: 'How does MADCAP receive results from the sorter?',
    systemA: 'MADCAP',
    systemB: 'sorter',
  },
  {
    query: 'What is the relationship between the analyser and MADCAP result entry?',
    systemA: 'analyser',
    systemB: 'MADCAP',
  },
  // ... more test cases
];

async function main() {
  console.log('\n=== INTERACTION DIAGNOSTIC REPORT ===\n');

  for (const testCase of testCases) {
    const options: RetrievalOptions = {
      interaction: {
        systemA: testCase.systemA,
        systemB: testCase.systemB,
        depthMode: 'standard',
      },
    };

    const results = await hybridSearchWithMode(testCase.query, 'interaction', options);

    console.log(`Query: "${testCase.query}"`);
    console.log(`Systems: ${testCase.systemA} ↔ ${testCase.systemB}`);
    console.log(`Total Sources: ${results.length}`);
    // Tier counts and doc diversity will be logged by hybridSearchWithMode
    console.log('');
  }
}

main().catch(console.error);
```

- [ ] **Step 2: Capture tier diagnostics from console logs**

The logs from `hybridSearchWithMode` (added in Task 2, Step 3) will be captured:

```
[interaction-retrieval] tier distribution: Tier1=2, Tier2=5, Tier3=1, total=8, docs=4
```

- [ ] **Step 3: Run diagnostic validation on current outlier queries**

```bash
cd '/Users/damian/Projects/Claude Cowork/idd-knowledge-chat' && \
node -e "
const fs = require('fs');
const report = JSON.parse(fs.readFileSync('docs/reports/2026-04-19-live-validation/chat-runtime-broad-coverage.json', 'utf8'));
const outliers = report.results.filter(r => r.sourceCount > 24);
console.log('Queries with source spam (>24):');
outliers.forEach(r => console.log(\  [\${r.category}] \${r.question.slice(0, 80)}\));
" 2>&1
```

- [ ] **Step 4: Run full 31-query validation suite**

```bash
npm run test:interaction-broad 2>&1 | tee /tmp/validation-output.log
```

Inspect the validation output for:
- All 31 queries still passing
- Outlier queries now have source count <= 20
- Tier diagnostics show balanced distribution (e.g., Tier1=1-2, Tier2=3-5, Tier3=0-1)
- Answer quality unchanged (all answers non-empty and visible)

- [ ] **Step 5: Commit**

```bash
git add scripts/validate-interaction-diagnostics.ts
git commit -m "test(scripts): add interaction diagnostic report for tier distribution and source counts"
```

---

## Task 5: Runtime Validation Against Full 31-Query Suite

**Files:**
- Inspect: `docs/reports/2026-04-19-live-validation/chat-runtime-broad-coverage.json`

**Goal:** Verify source spam reduction without answer degradation

- [ ] **Step 1: Run full validation suite**

```bash
cd '/Users/damian/Projects/Claude Cowork/idd-knowledge-chat' && \
npm run test:interaction-broad 2>&1 | tail -50
```

Expected output should show:
- allAnswersNonEmptyAndVisible: ✅ true
- interactionQueriesProduceNonEmptyAnswers: ✅ true
- Source count distribution improved

- [ ] **Step 2: Compare outlier queries before/after**

Manual inspection script:

```bash
node -e "
const fs = require('fs');
const report = JSON.parse(fs.readFileSync('docs/reports/2026-04-19-live-validation/chat-runtime-broad-coverage.json', 'utf8'));

console.log('Outlier Queries Analysis:');
const outliers = report.results.filter(r => r.sourceCount > 20).slice(0, 5);
outliers.forEach(r => {
  console.log(\\\n[\${r.category}]\\\n  Question: \${r.question.slice(0, 100)}\\\n  Sources: \${r.sourceCount}\\\n  Answer preview: \${r.answer.slice(0, 150)}...\\\n\);
});

const stats = report.results.reduce((acc, r) => {
  acc.maxSources = Math.max(acc.maxSources, r.sourceCount);
  acc.avgSources = acc.avgSources + r.sourceCount;
  return acc;
}, { maxSources: 0, avgSources: 0 });
stats.avgSources /= report.results.length;

console.log(\\\nOverall Statistics:\\\n  Max sources: \${stats.maxSources}\\\n  Avg sources: \${stats.avgSources.toFixed(1)}\\\n\);
"
```

- [ ] **Step 3: Verify answer quality on outliers**

For each of the 2 outlier queries, run manually and visually inspect:

```bash
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"query":"<outlier_query>","mode":"interaction"}' 2>&1 | head -100
```

Check:
- Answer is coherent and complete
- Mentions both system names
- Explains mechanism/flow
- No hallucination

- [ ] **Step 4: Create final validation report**

```bash
node -e "
const fs = require('fs');
const report = JSON.parse(fs.readFileSync('docs/reports/2026-04-19-live-validation/chat-runtime-broad-coverage.json', 'utf8'));

const stats = {
  totalQueries: report.results.length,
  allNonEmpty: report.results.every(r => r.answer?.trim()),
  maxSources: Math.max(...report.results.map(r => r.sourceCount)),
  avgSources: report.results.reduce((s, r) => s + r.sourceCount, 0) / report.results.length,
  queriesOver20: report.results.filter(r => r.sourceCount > 20).length,
  interactionQueries: report.results.filter(r => r.category.includes('interaction')).length,
};

console.log(\\\n✅ SOURCE SPAM REDUCTION VALIDATION REPORT\\\n\);
console.log(\\\nResults:\\\n  Total queries: \${stats.totalQueries}\\\n  All answers non-empty: \${stats.allNonEmpty}\\\n  Max sources: \${stats.maxSources} (target ≤ 20)\\\n  Avg sources: \${stats.avgSources.toFixed(1)}\\\n  Queries over 20 sources: \${stats.queriesOver20}\\\n  Interaction queries: \${stats.interactionQueries}\\\n\);
" 2>&1
```

- [ ] **Step 5: Commit**

```bash
git add docs/reports/
git commit -m "test(validation): source spam reduction verified - max sources reduced, answer quality maintained"
```

---

## Verification Checklist

Before moving to Step 2 (follow-up continuity hardening):

- [ ] All 31 queries still passing (100% pass rate)
- [ ] `allAnswersNonEmptyAndVisible: true`
- [ ] Max source count for any query ≤ 20 (was 28)
- [ ] Tier distribution shows balanced mix (Tier1 preserved, low Tier3)
- [ ] Outlier queries still have good answer quality
- [ ] Unit tests for tier classification and caps all passing
- [ ] Diagnostic logs show tier breakdown for each interaction query

---

## Rollback Plan

If answer quality degrades:

1. Revert `interactionHardCap` from 20 to 25
2. Increase `tier1Limit` from 2 to 3
3. Reduce `interactionMaxPerDoc` back to 4 if needed
4. Re-run validation and diagnostics
