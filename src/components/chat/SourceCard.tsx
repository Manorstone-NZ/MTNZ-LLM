'use client';

import { useState } from 'react';
import type { CitedChunk } from '@/lib/types';

interface SourceCardProps {
  sources: CitedChunk[];
}

export default function SourceCard({ sources }: SourceCardProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (!sources.length) return null;

  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {sources.map((source) => {
        const isExpanded = expandedId === source.chunk_id;
        return (
          <div key={source.chunk_id} className="inline-block">
            <button
              onClick={() => setExpandedId(isExpanded ? null : source.chunk_id)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs border transition-colors ${
                isExpanded
                  ? 'bg-slate-700 border-slate-500 text-slate-100'
                  : 'bg-slate-800 border-slate-700 text-slate-300 hover:border-slate-500 hover:text-slate-100'
              }`}
            >
              <span className="font-semibold text-blue-400">{source.citation_label}</span>
              <span className="text-slate-400">|</span>
              <span className="truncate max-w-[180px]">{source.doc_title}</span>
              {source.folder && (
                <>
                  <span className="text-slate-500">/</span>
                  <span className="text-slate-400">{source.folder}</span>
                </>
              )}
            </button>
            {isExpanded && (
              <div className="mt-1 p-2.5 rounded-md bg-slate-800 border border-slate-700 text-xs text-slate-300 max-w-md">
                {source.section_title && (
                  <div className="font-medium text-slate-200 mb-1">{source.section_title}</div>
                )}
                {source.page !== null && (
                  <div className="text-slate-500 mb-1">Page {source.page}</div>
                )}
                <p className="whitespace-pre-wrap leading-relaxed">{source.content_preview}</p>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
