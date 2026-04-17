# Comprehensive Answers + Minimized Reference Clutter Design

Date: 2026-04-17
Status: Draft for review

## Objective

Improve chat response usability by delivering more comprehensive grounded answers while reducing visible reference clutter.

## Scope

In scope:
- Increase assistant answer depth and structure when sufficient grounded evidence exists.
- Reduce inline citation density in answer prose.
- Replace per-chunk source badge strip with a single compact "Sources (N)" accordion.
- Aggregate sources by document inside the accordion.

Out of scope:
- Retrieval ranking logic changes.
- Embedding or chunking pipeline changes.
- Database schema changes.

## Current Behavior

- Prompt instructs the model to cite every substantive claim with `[Source: <label>]`.
- UI renders each retrieved chunk as a separate source badge.
- Repeated matches from the same document create visually noisy source lists.

## Proposed Behavior

### 1) Answer depth

Assistant responses should be comprehensive by default when evidence supports detail.

Expected response shape:
- Short direct answer first.
- Key details and context.
- Operational implications or usage context where available.
- Explicit caveats when evidence is partial.

### 2) Citation style

Use lighter inline citations with a hard floor:

Must cite:
- Every procedural claim, threshold, numeric value, or rule.
- Definitions and formal terms introduced for the first time.
- Document-specific responsibilities or policy claims.

May omit citation for:
- Contextual sentences that restate the same already-cited fact.
- Pure connective prose between cited claims.

Minimum citation density floor:
- At least 1 citation per logical section of the answer.
- At least 2 citations total for any answer that draws on multiple documents.

Examples:
- Cite: "FT3 refers to the MilkoScan FT3 instrument used for dairy component analysis." (definition claim)
- Cite: "LOP-QM 005 section 7.4.2 covers MilkoScan Cream (FT3) uncertainty handling." (procedural section claim)
- Do not repeat the same citation on two adjacent sentences that restate the same fact.

### 3) Source UI

Replace multi-badge strip with one `Sources (N)` accordion per assistant message, with single-source optimisation.

Single-source rule (N == 1):
- Show an inline compact source line instead of a full accordion.
- Format: `Source: <doc_title> — <section_title if present>`.
- No toggle needed; always visible.

Multi-source rule (N > 1):
- Collapsed by default.
- Header shows total number of unique documents referenced, e.g. `Sources (3)`.
- Expand to reveal one row per document.

Document row content:
- Document title.
- Best-matching section title (see selection rules below).
- Short merged preview from matched chunks in that document.

Future enhancement (v2, not in scope now):
- "Show detailed citations" toggle to expand inline references in the answer body for audit/traceability use cases.

## Data and Aggregation Rules

Input remains `CitedChunk[]` from the chat SSE `sources` event.

Current `CitedChunk` contract (from `src/lib/types.ts`):
- `chunk_id: string`
- `citation_label: string`
- `doc_title: string`
- `folder: string`
- `page: number | null`
- `section_title: string | null`
- `sheet_name: string | null`
- `content_preview: string`

Notes:
- The UI payload does not currently include `document_id` or score.
- This design does not change SSE payload shape for v1.

Aggregation key:
- Primary: `doc_title + folder + citation_family_key` triple.
- Merge only when all three align, or when confidence is high that the entries represent the same document version.
- Fallback: `doc_title + citation_family_key` if folder is unavailable.
- Do not merge on `doc_title` alone.

Citation family key derivation:
- Prefer regex prefix match from `citation_label` using `^[A-Z]+(?:-[A-Z]+)?\s*\d{3}\s*\(V\d+\)|^[A-Z]+(?:-[A-Z]+)?\s*\d{3}\s*V\d+`.
- If regex does not match, use text before first comma.
- If no comma exists, use full `citation_label`.

Safety rule:
- If family key cannot be derived reliably, do not merge ambiguous groups; keep separate entries to avoid false joins.

Version collision rule:
- `LOP-MC 001 (V1)` and `LOP-MC 001 (V2)` must never merge — version suffix is part of the family key.

Validation requirement:
- During implementation verification, sample at least 50 grouped source sets from golden queries and confirm no false merges across distinct manuals.

Per-document selection:
- Best section: choose `section_title` from the chunk with the longest `content_preview` in the group, as a proxy for most informative chunk.
- Tie-break: if two chunks have equal preview length, choose the one with more unique tokens (distinct words).
- Fallback: if no chunk has a non-empty `section_title`, omit section line.
- Preview: take the top 2–3 most distinct `content_preview` snippets from the group, prioritising longest and most unique. Join with `…` separator, clamp total to `280` characters with trailing ellipsis if needed.

De-duplication:
- Remove exact duplicate `content_preview` values within each grouped document.
- Matching is case-insensitive after whitespace normalization.
- Remove any snippet that is a full substring of another snippet already selected.

## API/Contract Impact

- No required SSE shape change for v1 implementation.
- Optional future optimization: emit pre-grouped document references from API with `document_id` included.

## Component-Level Plan

### Prompt layer

Update system prompt in `src/lib/prompts.ts` to:
- Request comprehensive, structured answers.
- Require citations for key claims rather than every substantive sentence.

Prompt changes should preserve these grounding constraints:
- Answer only from provided chunks.
- Explicitly state insufficiency when evidence is incomplete.
- Do not fabricate references.

Target prompt text update (replace current RULES block intent with equivalent wording):
- "Provide a comprehensive, structured answer when evidence supports it: direct answer, key details, operational context, and caveats."
- "Every procedural claim, threshold, numeric value, or rule MUST have a citation using `[Source: <exact label>]`."
- "Definitions and context claims should be cited on first use; do not repeat the same citation on adjacent sentences for the same fact."
- "Include at least 1 citation per logical section of your answer. If the answer draws on multiple documents, include at least 2 citations total."
- "If coverage is partial, explicitly state: 'Based on available sources…' or 'The available sources do not fully cover…'. Do not imply completeness when evidence is limited."
- "Do not fabricate references or use prior knowledge outside the provided chunks."

### Chat UI layer

Update source rendering component to:
- Show one compact control `Sources (N)`.
- Toggle accordion open/closed.
- Render grouped document rows with section and merged preview.

Primary implementation file targets:
- `src/components/chat/SourceCard.tsx` (replace badge-strip rendering with accordion + grouped rows).
- `src/components/chat/MessageBubble.tsx` (ensure unchanged integration point for `sources` prop; update only if wrapper layout needs adjustment).

Optional utility extraction target:
- `src/lib/citations.ts` (add pure grouping helper if needed for testability).

No expected changes to message transport flow.

## Error Handling and Edge Cases

- No sources: hide accordion entirely.
- No sources UI result: do not render source control or placeholder container.
- Missing section titles: omit section subtitle line.
- Very long previews: clamp to configured limit with ellipsis.
- Single-source answers: still use accordion for consistent interaction.

## Accessibility and UX

- Accordion trigger must be keyboard-focusable and use `aria-expanded`.
- Preserve readable contrast and existing dark theme styling.
- Keep layout compact on mobile and desktop.

## Testing Strategy

Unit tests:
- Grouping function groups chunks by document and deduplicates previews.
- Best section selection chooses chunk with longest preview, not first in arrival order.
- Preview merge selects top 2–3 distinct snippets and respects max length.
- Collision guard splits same-title groups with different citation families.
- Version collision test: `LOP-MC 001 (V1)` and `LOP-MC 001 (V2)` chunks are never merged into one group.

UI tests (component-level, if available):
- Collapsed default state.
- Expands/collapses correctly.
- Renders expected aggregated rows for duplicate chunk sources.

Manual verification:
- Use queries from `scripts/golden-queries.json` that return multiple chunks from the same document family (for example FT3-related manual references).
- Confirm comprehensive answer body with lower inline citation density.
- Confirm a single `Sources (N)` control and grouped rows.

Regression verification:
- Run `scripts/test-golden-queries.ts` before and after prompt/UI change and compare grounding quality manually on the same sampled queries.
- Ensure each key factual anchor in generated answers remains citation-backed.

## Risks and Mitigations

Risk:
- Lighter inline citations could reduce perceived traceability.
Mitigation:
- Keep explicit citations for anchor claims and full grouped provenance in accordion.

Risk:
- Grouping by title/folder could incorrectly merge similarly titled docs.
Mitigation:
- Preserve version text in title when available; revise key if document ID is exposed to UI later.

## Acceptance Criteria

- Assistant answers are materially more detailed for evidence-rich prompts.
- Every procedural claim, threshold, and rule in the answer body has an inline citation.
- Minimum citation density met: at least 1 per logical section; at least 2 for multi-document answers.
- Inline citations are visibly less repetitive (no repeated label on adjacent sentences for same fact).
- Source area under each answer shows a single `Sources (N)` accordion (or inline compact source for N == 1).
- Expanded source view contains one row per document, not one row per chunk.
- Rows include document title, best section label (if present), and top 2–3 merged distinct previews.
- No increase in hallucinated or weakly supported claims across golden queries (grounding quality check).
- Documents sharing title but different versions (e.g. V1 vs V2) appear as separate grouped rows.
- No regression to retrieval grounding behavior.

Definition of pass for grounding regression:
- For sampled golden queries, no factual anchor appears without at least one matching source citation in the answer body or source accordion context.
- Grounding quality is assessed manually by comparing pre/post answer accuracy on the same query set, not just presence of citation markers.
