'use client';

import { useState } from 'react';

interface ProgressEvent {
  file: string;
  status: string;
  processed: number;
  total: number;
}

interface IngestControlsProps {
  isIngesting: boolean;
  progress: ProgressEvent | null;
  onIngestNew: () => void;
  onFullRebuild: () => void;
}

export default function IngestControls({
  isIngesting,
  progress,
  onIngestNew,
  onFullRebuild,
}: IngestControlsProps) {
  const [showRebuildDialog, setShowRebuildDialog] = useState(false);
  const [confirmText, setConfirmText] = useState('');

  function handleRebuildConfirm() {
    if (confirmText === 'REBUILD') {
      setShowRebuildDialog(false);
      setConfirmText('');
      onFullRebuild();
    }
  }

  const pct = progress && progress.total > 0
    ? Math.round((progress.processed / progress.total) * 100)
    : 0;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <button
          onClick={onIngestNew}
          disabled={isIngesting}
          className="px-4 py-2 rounded-lg bg-[color:var(--brand)] text-white text-sm font-medium hover:bg-[color:var(--brand-strong)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Ingest New/Changed
        </button>
        <button
          onClick={() => setShowRebuildDialog(true)}
          disabled={isIngesting}
          className="px-4 py-2 rounded-lg bg-red-700 text-white text-sm font-medium hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Full Rebuild
        </button>
      </div>

      {/* Progress display */}
      {isIngesting && progress && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>
              {progress.status === 'clearing_database'
                ? 'Clearing database...'
                : progress.status === 'database_cleared'
                  ? 'Database cleared, starting ingest...'
                  : progress.file
                    ? `Processing: ${progress.file}`
                    : 'Starting...'}
            </span>
            {progress.total > 0 && (
              <span>
                {progress.processed} / {progress.total} ({pct}%)
              </span>
            )}
          </div>
          <div className="w-full h-2 rounded-full bg-[color:var(--surface-muted)] overflow-hidden">
            <div
              className="h-full rounded-full bg-[color:var(--brand)] transition-all duration-300"
              style={{ width: progress.total > 0 ? `${pct}%` : '0%' }}
            />
          </div>
        </div>
      )}

      {isIngesting && !progress && (
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <span className="inline-block w-3 h-3 border-2 border-[color:var(--brand)]/30 border-t-[color:var(--brand)] rounded-full animate-spin" />
          Connecting...
        </div>
      )}

      {/* Full Rebuild confirmation dialog */}
      {showRebuildDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-white border border-[color:var(--line)] rounded-lg p-6 max-w-md w-full mx-4 shadow-xl">
            <h3 className="text-lg font-semibold text-[color:var(--brand-strong)] mb-2">Confirm Full Rebuild</h3>
            <p className="text-sm text-slate-600 mb-4">
              This will delete all documents, chunks, and ingest history, then re-process every file from scratch.
              This action cannot be undone.
            </p>
            <label className="block text-sm text-slate-700 mb-2">
              Type <span className="font-mono font-bold text-red-400">REBUILD</span> to confirm:
            </label>
            <input
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRebuildConfirm();
                if (e.key === 'Escape') { setShowRebuildDialog(false); setConfirmText(''); }
              }}
              className="w-full rounded app-input px-3 py-2 text-sm placeholder-slate-400 focus:outline-none focus:border-red-500 mb-4"
              placeholder="REBUILD"
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => { setShowRebuildDialog(false); setConfirmText(''); }}
                className="px-4 py-2 rounded-lg bg-[color:var(--surface-muted)] text-slate-700 text-sm hover:bg-[color:var(--brand-soft)] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleRebuildConfirm}
                disabled={confirmText !== 'REBUILD'}
                className="px-4 py-2 rounded-lg bg-red-700 text-white text-sm font-medium hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Destroy &amp; Rebuild
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
