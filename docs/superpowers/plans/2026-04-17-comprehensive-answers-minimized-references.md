# Comprehensive Answers + Minimized References Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce richer, structured assistant answers while replacing the per-chunk source badge strip with a compact document-grouped accordion.

**Architecture:** Two independent layers change — the prompt in `src/lib/prompts.ts` (drives answer depth and citation density) and the source presentation in `src/components/chat/SourceCard.tsx` (drives grouping + accordion UX). A pure aggregation helper is added to `src/lib/citations.ts` and unit-tested independently before the UI consumes it.

**Tech Stack:** Next.js 16, React 19, TypeScript, Tailwind CSS (dark theme), no new dependencies.

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `src/lib/prompts.ts` | Updated system prompt with citation density rules |
| Modify | `src/lib/citations.ts` | Add `groupChunksByDocument()` pure helper |
| Create | `src/lib/citations.grouping.test.ts` | Unit tests for grouping helper |
| Modify | `src/components/chat/SourceCard.tsx` | Accordion + single-source inline UI |
| Modify | `src/components/chat/MessageBubble.tsx` | No logic change; verify prop contract unchanged |

---

## Task 1: Update system prompt

**Files:**
- Modify: `src/lib/prompts.ts`

Current `SYSTEM_PROMPT` rules are: cite every substantive claim, be concise. We're replacing the rules block to require comprehensive answers, cite procedural/factual anchors (not every sentence), enforce a citation density floor, and add explicit evidence-completeness language.

- [ ] **Step 1.1: Read current prompt**

Open `src/lib/prompts.ts` and note the exact `SYSTEM_PROMPT` constant.

- [ ] **Step 1.2: Replace SYSTEM_PROMPT**

Replace the `SYSTEM_PROMPT` constant with:

```typescript
export const SYSTEM_PROMPT = `You are an IDD knowledge assistant for the MTNZ LIMS replacement programme.

RULES:
- Answer ONLY from the provided source chunks. Do not use prior knowledge.
- Provide a comprehensive, structured answer when evidence supports it: direct answer, key details, operational context, and caveats. Be comprehensive but avoid unnecessary repetition or filler.
- Every procedural claim, threshold, numeric value, or rule MUST have a citation using the format [Source: <exact label>].
- Definitions and context claims should be cited on first use. Do not repeat the same citation on adjacent sentences for the same unchanged fact.
- Include at least one citation per logical section of your answer. If your answer draws on multiple documents, include at least two citations total.
- Use the EXACT citation label shown after "CITE AS:" for each source. Do NOT cite as [Chunk 1] or [Source 1].
- If coverage is partial, explicitly state: "Based on available sources…" or "The available sources do not fully cover…". Do not imply completeness when evidence is limited.
- If sources conflict, present both with their citations and note the conflict.
- Never stitch across documents without making the cross-reference explicit.
- If the provided chunks do not contain sufficient evidence to answer, say: "No grounded evidence found in the document corpus for this question."`;
```

- [ ] **Step 1.3: Commit**

```bash
git add src/lib/prompts.ts
git commit -m "feat: comprehensive answers with citation density floor"
```

---

## Task 2: Add grouping helper to citations.ts

**Files:**
- Create: `src/lib/citations.grouping.test.ts`
- Modify: `src/lib/citations.ts`

The helper takes `CitedChunk[]` and returns `GroupedSource[]`. It is a pure function with no React dependency — easy to unit test in isolation.

### Types to add to `src/lib/citations.ts`

```typescript
export interface GroupedSource {
  groupKey: string;          // doc_title + folder + familyKey
  doc_title: string;
  folder: string;
  section_title: string | null;
  preview: string;           // merged, clamped
  chunks: CitedChunk[];      // original chunks for debugging/future use
}
```

### Citation family key derivation

```typescript
function deriveFamilyKey(citationLabel: string): string {
  const prefixRegex = /^([A-Z]+(?:-[A-Z]+)?\s*\d{3}\s*(?:\(?V\d+\)?))/i;
  const match = citationLabel.match(prefixRegex);
  if (match) return match[1].trim();
  const commaIdx = citationLabel.indexOf(',');
  return commaIdx !== -1 ? citationLabel.slice(0, commaIdx).trim() : citationLabel.trim();
}
```

### Aggregation logic

```typescript
export function groupChunksByDocument(chunks: CitedChunk[]): GroupedSource[] {
  const groups = new Map<string, CitedChunk[]>();

  for (const chunk of chunks) {
    const familyKey = deriveFamilyKey(chunk.citation_label);
    const folder = chunk.folder ?? '';
    const groupKey = `${chunk.doc_title}|||${folder}|||${familyKey}`;
    const existing = groups.get(groupKey) ?? [];
    groups.set(groupKey, [...existing, chunk]);
  }

  return Array.from(groups.entries())
  .map(([groupKey, groupChunks]) => {
    const first = groupChunks[0];
    // cap processing to 10 chunks max per group before sorting
    const cappedChunks = groupChunks.slice(0, 10);

    // Best section: chunk with longest content_preview (proxy for most informative)
    const bestChunk = cappedChunks.reduce((a, b) =>
      (b.content_preview?.length ?? 0) > (a.content_preview?.length ?? 0) ? b : a
    );
    const section_title = bestChunk.section_title ?? null;

    // Preview: top 2-3 distinct snippets, clamped to 280 chars
    const preview = buildPreview(cappedChunks);

    return {
      groupKey,
      doc_title: first.doc_title || 'Unknown document',
      folder: first.folder,
      section_title,
      preview,
      chunks: groupChunks,
    };
  })
  .sort((a, b) =>
    b.chunks.length - a.chunks.length ||
    b.preview.length - a.preview.length
  );
}

const PREVIEW_MAX_CHARS = 280;
const PREVIEW_MAX_SNIPPETS = 3;

function buildPreview(chunks: CitedChunk[]): string {
  const normalise = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

  // Sort by preview length descending (most informative first), cap at 10 before processing
  const sorted = [...chunks]
    .sort((a, b) => (b.content_preview?.length ?? 0) - (a.content_preview?.length ?? 0))
    .slice(0, 10);

  const selected: string[] = [];
  for (const chunk of sorted) {
    if (!chunk.content_preview) continue;
    const norm = normalise(chunk.content_preview);
    // Skip exact duplicates and full substrings of already-selected text
    const isDuplicate = selected.some(
      (s) => normalise(s) === norm || normalise(s).includes(norm) || norm.includes(normalise(s))
    );
    if (!isDuplicate) selected.push(chunk.content_preview.replace(/\s+/g, ' ').trim());
    if (selected.length >= PREVIEW_MAX_SNIPPETS) break;
  }

  const joined = selected.join(' … ');
  if (!joined.trim()) return 'No preview available from matched sections.';
  if (joined.length <= PREVIEW_MAX_CHARS) return joined;
  return joined.slice(0, PREVIEW_MAX_CHARS - 1) + '…';
}
```

- [ ] **Step 2.1: Write failing tests first**

Create `src/lib/citations.grouping.test.ts`:

```typescript
import { groupChunksByDocument } from './citations';
import type { CitedChunk } from './types';

function makeChunk(overrides: Partial<CitedChunk> & { chunk_id: string }): CitedChunk {
  return {
    citation_label: 'LOP-MC 001 (V1), Section 1',
    doc_title: 'Test Manual',
    folder: 'LOP',
    page: null,
    section_title: null,
    sheet_name: null,
    content_preview: 'Some content.',
    ...overrides,
  };
}

test('groups chunks from same document into one entry', () => {
  const chunks = [
    makeChunk({ chunk_id: 'a', content_preview: 'Content A.' }),
    makeChunk({ chunk_id: 'b', content_preview: 'Content B.' }),
  ];
  const result = groupChunksByDocument(chunks);
  expect(result).toHaveLength(1);
  expect(result[0].chunks).toHaveLength(2);
});

test('keeps different documents separate', () => {
  const chunks = [
    makeChunk({ chunk_id: 'a', doc_title: 'Manual A', citation_label: 'LOP-MC 001 (V1)' }),
    makeChunk({ chunk_id: 'b', doc_title: 'Manual B', citation_label: 'LOP-MC 002 (V1)' }),
  ];
  const result = groupChunksByDocument(chunks);
  expect(result).toHaveLength(2);
});

test('does NOT merge different versions of same document', () => {
  const chunks = [
    makeChunk({ chunk_id: 'a', citation_label: 'LOP-MC 001 (V1), Section 1' }),
    makeChunk({ chunk_id: 'b', citation_label: 'LOP-MC 001 (V2), Section 1' }),
  ];
  const result = groupChunksByDocument(chunks);
  expect(result).toHaveLength(2);
});

test('selects section from chunk with longest preview', () => {
  const chunks = [
    makeChunk({ chunk_id: 'a', section_title: 'Short', content_preview: 'Short.' }),
    makeChunk({ chunk_id: 'b', section_title: 'Long', content_preview: 'This is a much longer preview with more content.' }),
  ];
  const result = groupChunksByDocument(chunks);
  expect(result[0].section_title).toBe('Long');
});

test('omits section_title when none present', () => {
  const chunks = [makeChunk({ chunk_id: 'a', section_title: null })];
  const result = groupChunksByDocument(chunks);
  expect(result[0].section_title).toBeNull();
});

test('preview includes at most 3 snippets', () => {
  const chunks = [
    makeChunk({ chunk_id: 'a', content_preview: 'Alpha content here.' }),
    makeChunk({ chunk_id: 'b', content_preview: 'Beta content here, longer text.' }),
    makeChunk({ chunk_id: 'c', content_preview: 'Gamma content here, even longer text now.' }),
    makeChunk({ chunk_id: 'd', content_preview: 'Delta content here, the fourth distinct snippet.' }),
  ];
  const result = groupChunksByDocument(chunks);
  // At most 3 snippets joined; not all 4 should appear
  const snippetCount = (result[0].preview.match(/ … /g) ?? []).length + 1;
  expect(snippetCount).toBeLessThanOrEqual(3);
});

test('preview is clamped to 280 chars', () => {
  const longText = 'A'.repeat(100);
  const chunks = [
    makeChunk({ chunk_id: 'a', content_preview: longText }),
    makeChunk({ chunk_id: 'b', content_preview: 'B'.repeat(100) }),
    makeChunk({ chunk_id: 'c', content_preview: 'C'.repeat(100) }),
  ];
  const result = groupChunksByDocument(chunks);
  expect(result[0].preview.length).toBeLessThanOrEqual(280);
});

test('deduplicates exact duplicate previews', () => {
  const chunks = [
    makeChunk({ chunk_id: 'a', content_preview: 'Same content.' }),
    makeChunk({ chunk_id: 'b', content_preview: 'Same content.' }),
  ];
  const result = groupChunksByDocument(chunks);
  expect(result[0].preview).toBe('Same content.');
});

test('does NOT merge chunks from same title but different folders', () => {
  const chunks = [
    makeChunk({ chunk_id: 'a', folder: 'LOP' }),
    makeChunk({ chunk_id: 'b', folder: 'EOP' }),
  ];
  const result = groupChunksByDocument(chunks);
  expect(result).toHaveLength(2);
});

test('returns fallback preview text when all previews are empty', () => {
  const chunks = [makeChunk({ chunk_id: 'a', content_preview: '' })];
  const result = groupChunksByDocument(chunks);
  expect(result[0].preview).toBe('No preview available from matched sections.');
});

test('uses Unknown document fallback when doc_title is missing', () => {
  const chunks = [makeChunk({ chunk_id: 'a', doc_title: '' })];
  const result = groupChunksByDocument(chunks);
  expect(result[0].doc_title).toBe('Unknown document');
});
```

- [ ] **Step 2.2: Run tests — expect failures**

```bash
cd /Users/damian/Projects/Claude\ Cowork/idd-knowledge-chat && npx tsx --test src/lib/citations.grouping.test.ts
```

Expected: all tests fail (functions not yet defined). If any pass, the function already exists — investigate before proceeding.

- [ ] **Step 2.3: Add GroupedSource type and helper to citations.ts**

Add to `src/lib/citations.ts`:

- `GroupedSource` interface
- `deriveFamilyKey()` internal function
- `buildPreview()` internal function  
- `groupChunksByDocument()` exported function

Use exact implementations shown above in Task 2 description.

- [ ] **Step 2.4: Run tests — expect all pass**

```bash
cd /Users/damian/Projects/Claude\ Cowork/idd-knowledge-chat && npx tsx --test src/lib/citations.grouping.test.ts
```

Expected: all 12 tests pass, 0 failures.

- [ ] **Step 2.5: Commit**

```bash
git add src/lib/citations.ts src/lib/citations.grouping.test.ts
git commit -m "feat: add groupChunksByDocument helper with version-safe grouping"
```

---

## Task 3: Replace SourceCard with accordion + single-source UX

**Files:**
- Modify: `src/components/chat/SourceCard.tsx`

The component takes the same `sources: CitedChunk[]` prop (no API change). It calls `groupChunksByDocument()` internally to build grouped rows.

Single-source rule (N == 1 unique document group):
- Render an inline compact line: `Source: <doc_title> — <section_title>` (no toggle).

Multi-source rule (N > 1):
- Collapsed by default.
- Toggle button shows `Sources (N)` with a small chevron icon.
- Expanded: one row per grouped document.

Full replacement for `src/components/chat/SourceCard.tsx`:

```tsx
'use client';

import { useState } from 'react';
import type { CitedChunk } from '@/lib/types';
import { groupChunksByDocument } from '@/lib/citations';

interface SourceCardProps {
  sources: CitedChunk[];
}

export default function SourceCard({ sources }: SourceCardProps) {
  const [isOpen, setIsOpen] = useState(false);

  if (!sources.length) return null;

  const groups = groupChunksByDocument(sources);

  // Single-source optimisation: inline compact line, no toggle
  if (groups.length === 1) {
    const g = groups[0];
    return (
      <div className="mt-2 text-xs text-slate-400">
        <span className="text-slate-500">Source: </span>
        <span className="text-slate-300">{g.doc_title}</span>
        {g.section_title && (
          <>
            <span className="text-slate-600 mx-1">—</span>
            <span className="text-slate-400">{g.section_title}</span>
          </>
        )}
      </div>
    );
  }

  // Multi-source: accordion
  return (
    <div className="mt-2">
      <button
        onClick={() => setIsOpen((o) => !o)}
        aria-expanded={isOpen}
        aria-label={`${isOpen ? 'Collapse' : 'Expand'} sources (${groups.length} documents)`}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs border border-slate-700 bg-slate-800 text-slate-400 hover:text-slate-200 hover:border-slate-500 transition-colors"
      >
        <span>Sources ({groups.length})</span>
        <svg
          className={`w-3 h-3 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="M2 4l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {isOpen && (
        <div className="mt-1.5 space-y-1.5">
          {groups.map((g) => (
            <div
              key={g.groupKey}
              className="px-3 py-2 rounded-md bg-slate-800 border border-slate-700 text-xs"
            >
              <div className="flex items-baseline gap-1.5 flex-wrap">
                <span className="font-semibold text-slate-200">{g.doc_title}</span>
                {g.folder && (
                  <span className="text-slate-500 text-[10px]">{g.folder}</span>
                )}
              </div>
              {g.section_title && (
                <div className="text-slate-400 mt-0.5">{g.section_title}</div>
              )}
              {g.preview && (
                <p className="text-slate-500 mt-1 leading-relaxed">{g.preview}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3.1: Replace SourceCard.tsx with implementation above**

Replace entire content of `src/components/chat/SourceCard.tsx` with the component shown above.

- [ ] **Step 3.2: Verify TypeScript builds cleanly**

```bash
cd /Users/damian/Projects/Claude\ Cowork/idd-knowledge-chat && npx tsc --noEmit
```

Expected: exit 0, no errors.

- [ ] **Step 3.3: Verify MessageBubble.tsx needs no changes**

Open `src/components/chat/MessageBubble.tsx`. Confirm:
- It passes `sources={msg.sources}` to `SourceCard` (prop name unchanged).
- No import change needed.

If anything is broken, fix it. Otherwise skip.

- [ ] **Step 3.4: Commit**

```bash
git add src/components/chat/SourceCard.tsx
git commit -m "feat: replace source badges with grouped accordion UI"
```

---

## Task 4: Manual verification

- [ ] **Step 4.1: Start dev server (if not running)**

```bash
cd /Users/damian/Projects/Claude\ Cowork/idd-knowledge-chat && npm run dev
```

- [ ] **Step 4.2: Run a golden query that returns multi-document results**

Visit http://localhost:3000 and ask:

> "What is the FT3 instrument and where is it referenced?"

Expected result:
- Answer body contains a structured response with inline citations on key claims (not on every sentence).
- Source area shows `Sources (N)` button (N > 1), collapsed by default.
- Clicking expands a list of one row per document (not per chunk).
- Each row shows doc title, section (if present), short preview.

- [ ] **Step 4.3: Run a single-document query**

Ask:

> "What are the reagents and standards in the MilkoScan FT3 manual?"

Expected result:
- Answer cites the key procedural points.
- Source area shows inline compact `Source: EOP 001 (V3) MilkoScan FT3 Manual — 5 REAGENTS AND STANDARDS` (no accordion).

- [ ] **Step 4.4: Run a no-evidence query**

Ask:

> "What is the CEO birthday?"

Expected result:
- Answer says no grounded evidence.
- No source control rendered.

- [ ] **Step 4.6: Run a cross-document synthesis query**

Ask:

> "Compare the MADCAP sample selection and result release process"

Expected result:
- Answer draws from multiple documents.
- Each cross-document claim is explicitly cited.
- Answer does not silently stitch claims from different manuals — cross-references are explicit.
- Sources accordion shows multiple grouped rows.

- [ ] **Step 4.6: Commit verification note**

```bash
git commit --allow-empty -m "chore: manual verification passed for accordion + single-source UX"
```

---

## Task 5: Run full test suite and confirm no regressions

- [ ] **Step 5.1: Run all tests**

```bash
cd /Users/damian/Projects/Claude\ Cowork/idd-knowledge-chat && npx tsx --test 'src/**/*.test.ts'
```

Expected: all tests pass, 0 failures.

- [ ] **Step 5.2: Fix any regressions before proceeding**

If tests fail, fix them. Do not proceed with broken tests.

- [ ] **Step 5.3: Final commit**

```bash
git add -A
git commit -m "feat: comprehensive answers + compact grouped sources complete"
```

---

## Done

The implementation is complete when:
- All unit tests in `src/lib/citations.grouping.test.ts` pass.
- TypeScript builds with no errors.
- Manual verification passes for multi-source, single-source, and no-evidence cases.
- No regressions in existing test suite.
