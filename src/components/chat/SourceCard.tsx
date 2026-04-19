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

  // Single-source optimisation: keep this visible and low-friction.
  if (groups.length === 1) {
    const group = groups[0];
    return (
      <div className="mt-2 text-xs text-slate-400">
        <span className="text-slate-500">Source: </span>
        <span className="text-slate-300">{group.doc_title}</span>
        {group.preview_image_url && (
          <span className="ml-2 rounded bg-sky-900/50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-sky-300">
            Image
          </span>
        )}
        {group.section_title && (
          <>
            <span className="mx-1 text-slate-600">-</span>
            <span className="text-slate-400">{group.section_title}</span>
          </>
        )}
        {group.preview_image_url && (
          <div className="mt-2 max-w-xs overflow-hidden rounded-md border border-slate-700 bg-slate-900">
            <a
              href={group.preview_image_url}
              target="_blank"
              rel="noreferrer"
              className="block"
            >
              <img
                src={group.preview_image_url}
                alt={group.doc_title}
                className="max-h-40 w-full object-contain bg-slate-950"
              />
            </a>
            <div className="border-t border-slate-800 px-2 py-1">
              <a
                href={group.preview_image_url}
                target="_blank"
                rel="noreferrer"
                className="text-[11px] text-sky-400 hover:text-sky-300"
              >
                Open image preview
              </a>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="mt-2">
      <button
        onClick={() => setIsOpen((open) => !open)}
        aria-expanded={isOpen}
        aria-label={`${isOpen ? 'Collapse' : 'Expand'} sources (${groups.length} documents)`}
        className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs text-slate-400 transition-colors hover:border-slate-500 hover:text-slate-200"
      >
        <span>Sources ({groups.length})</span>
        <svg
          className={`h-3 w-3 transition-transform ${isOpen ? 'rotate-180' : ''}`}
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
          {groups.map((group) => (
            <div
              key={group.groupKey}
              className="rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-xs"
            >
              <div className="flex flex-wrap items-baseline gap-1.5">
                <span className="font-semibold text-slate-200">{group.doc_title}</span>
                {group.preview_image_url && (
                  <span className="rounded bg-sky-900/50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-sky-300">
                    Image
                  </span>
                )}
                {group.folder && (
                  <span className="text-[10px] text-slate-500">{group.folder}</span>
                )}
              </div>
              {group.section_title && (
                <div className="mt-0.5 text-slate-400">{group.section_title}</div>
              )}
              {group.preview && (
                <p className="mt-1 leading-relaxed text-slate-500">{group.preview}</p>
              )}
              {group.preview_image_url && (
                <div className="mt-2 max-w-xs overflow-hidden rounded-md border border-slate-700 bg-slate-900">
                  <a
                    href={group.preview_image_url}
                    target="_blank"
                    rel="noreferrer"
                    className="block"
                  >
                    <img
                      src={group.preview_image_url}
                      alt={group.doc_title}
                      className="max-h-40 w-full object-contain bg-slate-950"
                    />
                  </a>
                  <div className="border-t border-slate-800 px-2 py-1">
                    <a
                      href={group.preview_image_url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[11px] text-sky-400 hover:text-sky-300"
                    >
                      Open image preview
                    </a>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
