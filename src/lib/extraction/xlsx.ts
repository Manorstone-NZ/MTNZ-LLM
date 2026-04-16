import * as XLSX from 'xlsx';
import type { ExtractedContent, ExtractedSection } from '../types';

/**
 * Extract content from an XLSX workbook buffer.
 *
 * Each sheet is broken into logical table groups (separated by blank rows).
 * Each group becomes an ExtractedSection of type 'table' with column headers,
 * range references, and formula-presence metadata.
 */
export async function extractXlsx(
  buffer: Buffer,
  filename: string,
): Promise<ExtractedContent> {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellFormula: true });

  const sections: ExtractedSection[] = [];
  const textParts: string[] = [];
  let totalRows = 0;
  let totalSheets = workbook.SheetNames.length;
  const sheetNames: string[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;

    sheetNames.push(sheetName);

    const ref = sheet['!ref'];
    if (!ref) {
      // Empty sheet — still record it
      sections.push({
        title: sheetName,
        content: `Sheet: ${sheetName}\n(empty)`,
        type: 'table',
      });
      textParts.push(`Sheet: ${sheetName}\n(empty)\n`);
      continue;
    }

    const range = XLSX.utils.decode_range(ref);
    const mergeMap = buildMergeMap(sheet['!merges'] ?? []);

    // Read all rows as raw cell values (respecting merges)
    const rows: (string | null)[][] = [];
    for (let r = range.s.r; r <= range.e.r; r++) {
      const row: (string | null)[] = [];
      for (let c = range.s.c; c <= range.e.c; c++) {
        const value = getCellValue(sheet, r, c, mergeMap);
        row.push(value);
      }
      rows.push(row);
    }

    // Detect formula presence across the sheet
    const formulaPresent = detectFormulas(sheet, range);

    // Split rows into table groups separated by blank rows
    const groups = splitIntoTableGroups(rows);

    for (let gi = 0; gi < groups.length; gi++) {
      const group = groups[gi];
      if (group.length === 0) continue;

      // First non-empty row of each group is treated as column headers
      const headerRow = group[0];
      const columnHeaders = headerRow
        .map((v) => (v ?? '').trim())
        .filter((v) => v.length > 0);

      const dataRows = group.slice(1);
      totalRows += dataRows.length;

      // Build text representation
      const colCount = headerRow.length;
      const headerLine = headerRow.map((v) => (v ?? '').trim()).join(' | ');

      const lines: string[] = [];
      const titleSuffix =
        groups.length > 1 ? ` — Table ${gi + 1}` : '';
      const title = `${sheetName}${titleSuffix}`;

      lines.push(`Sheet: ${title}`);
      if (columnHeaders.length > 0) {
        lines.push(`Columns: ${headerLine}`);
      }
      lines.push('---');

      for (const dataRow of dataRows) {
        const cells = [];
        for (let c = 0; c < colCount; c++) {
          cells.push((dataRow[c] ?? '').trim());
        }
        lines.push(cells.join(' | '));
      }

      const content = lines.join('\n');

      // Compute range ref for this group
      const groupStartRow = findGroupStartRow(rows, group, range.s.r);
      const groupEndRow = groupStartRow + group.length - 1;
      const rangeRef = XLSX.utils.encode_range({
        s: { r: groupStartRow, c: range.s.c },
        e: { r: groupEndRow, c: range.e.c },
      });

      sections.push({
        title,
        content,
        type: 'table',
        // ExtractedSection doesn't have a metadata field in the interface,
        // but we store sheet info in the content for downstream use.
        // The metadata is conveyed at the top-level ExtractedContent.metadata
        // and in the section content itself.
      });

      // Store section-level metadata as a structured comment in the content
      // so downstream chunkers can parse it if needed.
      // Actually — let's attach it via a cast since PreparedChunk expects sheet_name etc.
      const sectionWithMeta = sections[sections.length - 1] as ExtractedSection & {
        metadata?: Record<string, unknown>;
      };
      sectionWithMeta.metadata = {
        sheet_name: sheetName,
        column_headers: columnHeaders,
        range_ref: rangeRef,
        row_count: dataRows.length,
        formula_present: formulaPresent,
      };

      textParts.push(content);
      textParts.push(''); // blank line between groups
    }
  }

  const text = textParts.join('\n').trim();

  return {
    text,
    sections,
    metadata: {
      sheet_count: totalSheets,
      sheet_names: sheetNames,
      total_data_rows: totalRows,
      filename,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map from "r,c" to the value of the top-left cell of its merge range. */
type MergeMap = Map<string, { sourceRow: number; sourceCol: number }>;

function buildMergeMap(merges: XLSX.Range[]): MergeMap {
  const map: MergeMap = new Map();
  for (const m of merges) {
    for (let r = m.s.r; r <= m.e.r; r++) {
      for (let c = m.s.c; c <= m.e.c; c++) {
        if (r === m.s.r && c === m.s.c) continue; // skip the source cell
        map.set(`${r},${c}`, { sourceRow: m.s.r, sourceCol: m.s.c });
      }
    }
  }
  return map;
}

function getCellValue(
  sheet: XLSX.WorkSheet,
  row: number,
  col: number,
  mergeMap: MergeMap,
): string | null {
  const key = `${row},${col}`;
  const merged = mergeMap.get(key);
  if (merged) {
    // This cell is part of a merge — return null so we don't duplicate.
    // The value will appear from the source cell.
    return null;
  }

  const addr = XLSX.utils.encode_cell({ r: row, c: col });
  const cell = sheet[addr];
  if (!cell) return null;

  // Use formatted text if available, otherwise the raw value
  if (cell.w !== undefined) return cell.w;
  if (cell.v !== undefined) return String(cell.v);
  return null;
}

function detectFormulas(sheet: XLSX.WorkSheet, range: XLSX.Range): boolean {
  for (let r = range.s.r; r <= range.e.r; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = sheet[addr];
      if (cell && cell.f) return true;
    }
  }
  return false;
}

function isBlankRow(row: (string | null)[]): boolean {
  return row.every((v) => v === null || v.trim() === '');
}

/**
 * Split an array of rows into groups separated by one or more blank rows.
 * Strips leading/trailing blank rows from each group.
 */
function splitIntoTableGroups(rows: (string | null)[][]): (string | null)[][][] {
  const groups: (string | null)[][][] = [];
  let current: (string | null)[][] = [];

  for (const row of rows) {
    if (isBlankRow(row)) {
      if (current.length > 0) {
        groups.push(current);
        current = [];
      }
    } else {
      current.push(row);
    }
  }
  if (current.length > 0) {
    groups.push(current);
  }
  return groups;
}

/**
 * Find the absolute row index (in the original rows array) where a group starts.
 */
function findGroupStartRow(
  allRows: (string | null)[][],
  group: (string | null)[][],
  baseRow: number,
): number {
  // group[0] is a reference to one of the rows in allRows
  const idx = allRows.indexOf(group[0]);
  return idx >= 0 ? baseRow + idx : baseRow;
}
