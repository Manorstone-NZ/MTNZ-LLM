'use client';

import { useState } from 'react';

interface DocumentRow {
  id: string;
  title: string;
  filename: string;
  source_path: string;
  folder: string;
  source_type: string;
  version_hash: string;
  is_active: boolean;
  superseded_at: string | null;
  last_seen_at: string;
  document_date: string | null;
  chunk_count: number;
  extraction_status: string;
  extraction_error: string | null;
  ocr_used: boolean;
  ocr_confidence: number | null;
  source_missing: boolean;
  processed_at: string | null;
  created_at: string;
  updated_at: string;
}

type SortKey = 'title' | 'folder' | 'source_type' | 'extraction_status' | 'chunk_count' | 'processed_at';
type SortDir = 'asc' | 'desc';

const FOLDERS = ['All', 'EOP', 'LOP', 'Recordings', 'Supporting', 'Architecture'] as const;
const STATUSES = ['All', 'completed', 'failed', 'pending'] as const;
const TYPES = ['All', 'pdf', 'docx', 'xlsx', 'txt'] as const;

function StatusBadge({ status }: { status: string }) {
  const base = 'inline-flex items-center px-2 py-0.5 rounded text-xs font-medium';
  switch (status) {
    case 'completed':
      return <span className={`${base} bg-green-900/50 text-green-300`}>completed</span>;
    case 'failed':
      return <span className={`${base} bg-red-900/50 text-red-300`}>failed</span>;
    case 'pending':
      return <span className={`${base} bg-yellow-900/50 text-yellow-300`}>pending</span>;
    default:
      return <span className={`${base} bg-slate-700 text-slate-300`}>{status}</span>;
  }
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '--';
  return new Date(dateStr).toLocaleDateString('en-NZ', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

interface DocumentTableProps {
  documents: DocumentRow[];
  onReprocess: (id: string) => void;
  onRemove: (id: string) => void;
  isIngesting: boolean;
  filters: { folder: string; status: string; type: string };
  onFilterChange: (key: 'folder' | 'status' | 'type', value: string) => void;
}

export default function DocumentTable({
  documents,
  onReprocess,
  onRemove,
  isIngesting,
  filters,
  onFilterChange,
}: DocumentTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>('title');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  const sorted = [...documents].sort((a, b) => {
    const dir = sortDir === 'asc' ? 1 : -1;
    const aVal = a[sortKey];
    const bVal = b[sortKey];
    if (aVal == null && bVal == null) return 0;
    if (aVal == null) return 1;
    if (bVal == null) return -1;
    if (typeof aVal === 'number' && typeof bVal === 'number') return (aVal - bVal) * dir;
    return String(aVal).localeCompare(String(bVal)) * dir;
  });

  const sortIndicator = (key: SortKey) => {
    if (sortKey !== key) return null;
    return <span className="ml-1 text-blue-400">{sortDir === 'asc' ? '\u2191' : '\u2193'}</span>;
  };

  const thClass = 'px-3 py-2 text-left text-xs font-medium text-slate-400 uppercase tracking-wider cursor-pointer hover:text-slate-200 select-none whitespace-nowrap';

  return (
    <div>
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <FilterSelect
          label="Folder"
          value={filters.folder}
          options={FOLDERS}
          onChange={(v) => onFilterChange('folder', v)}
        />
        <FilterSelect
          label="Status"
          value={filters.status}
          options={STATUSES}
          onChange={(v) => onFilterChange('status', v)}
        />
        <FilterSelect
          label="Type"
          value={filters.type}
          options={TYPES}
          onChange={(v) => onFilterChange('type', v)}
        />
        <span className="text-xs text-slate-500 ml-auto">
          {documents.length} document{documents.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border border-slate-700/50">
        <table className="w-full text-sm">
          <thead className="bg-slate-800/80">
            <tr>
              <th className={thClass} onClick={() => handleSort('title')}>Title{sortIndicator('title')}</th>
              <th className={thClass} onClick={() => handleSort('folder')}>Folder{sortIndicator('folder')}</th>
              <th className={thClass} onClick={() => handleSort('source_type')}>Type{sortIndicator('source_type')}</th>
              <th className={thClass} onClick={() => handleSort('extraction_status')}>Status{sortIndicator('extraction_status')}</th>
              <th className={thClass} onClick={() => handleSort('chunk_count')}>Chunks{sortIndicator('chunk_count')}</th>
              <th className={thClass} onClick={() => handleSort('processed_at')}>Processed{sortIndicator('processed_at')}</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-slate-400 uppercase tracking-wider whitespace-nowrap">Active</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-slate-400 uppercase tracking-wider whitespace-nowrap">Missing</th>
              <th className="px-3 py-2 text-right text-xs font-medium text-slate-400 uppercase tracking-wider whitespace-nowrap">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700/40">
            {sorted.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-8 text-center text-slate-500">
                  No documents found
                </td>
              </tr>
            )}
            {sorted.map((doc) => {
              const rowBorder = doc.extraction_status === 'failed'
                ? 'border-l-4 border-l-red-500'
                : doc.source_missing
                  ? 'border-l-4 border-l-amber-500'
                  : 'border-l-4 border-l-transparent';

              const rowBg = doc.extraction_status === 'failed'
                ? 'bg-red-950/20'
                : doc.source_missing
                  ? 'bg-amber-950/20'
                  : '';

              return (
                <tr
                  key={doc.id}
                  className={`${rowBorder} ${rowBg} hover:bg-slate-800/60 transition-colors`}
                >
                  <td className="px-3 py-2 text-slate-200 max-w-[280px] truncate" title={doc.title}>
                    {doc.title}
                    {doc.ocr_used && (
                      <span className="ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-violet-900/50 text-violet-300">
                        OCR
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-300">{doc.folder}</td>
                  <td className="px-3 py-2 text-slate-300 uppercase">{doc.source_type}</td>
                  <td className="px-3 py-2"><StatusBadge status={doc.extraction_status} /></td>
                  <td className="px-3 py-2 text-slate-300 tabular-nums">{doc.chunk_count}</td>
                  <td className="px-3 py-2 text-slate-400 whitespace-nowrap">{formatDate(doc.processed_at)}</td>
                  <td className="px-3 py-2">
                    {doc.is_active ? (
                      <span className="text-green-400" title="Active">&#x2713;</span>
                    ) : (
                      <span className="text-slate-600" title="Inactive">&#x2717;</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {doc.source_missing && (
                      <span className="text-amber-400" title="Source file missing">&#x26A0;</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <button
                      onClick={() => onReprocess(doc.id)}
                      disabled={isIngesting}
                      className="text-xs px-2 py-1 rounded bg-slate-700 text-slate-300 hover:bg-slate-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors mr-1"
                    >
                      Reprocess
                    </button>
                    {confirmRemoveId === doc.id ? (
                      <span className="inline-flex items-center gap-1">
                        <button
                          onClick={() => { onRemove(doc.id); setConfirmRemoveId(null); }}
                          className="text-xs px-2 py-1 rounded bg-red-700 text-red-100 hover:bg-red-600 transition-colors"
                        >
                          Confirm
                        </button>
                        <button
                          onClick={() => setConfirmRemoveId(null)}
                          className="text-xs px-2 py-1 rounded bg-slate-700 text-slate-300 hover:bg-slate-600 transition-colors"
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        onClick={() => setConfirmRemoveId(doc.id)}
                        disabled={isIngesting}
                        className="text-xs px-2 py-1 rounded bg-slate-700 text-red-400 hover:bg-red-900/50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-slate-400">
      {label}:
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded bg-slate-800 border border-slate-700 text-slate-200 text-xs px-2 py-1.5 focus:outline-none focus:border-blue-500"
      >
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    </label>
  );
}
