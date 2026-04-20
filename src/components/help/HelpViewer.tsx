'use client';

import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { HelpGuideDefinition } from '@/lib/helpGuides';

interface HelpViewerProps {
  guides: ReadonlyArray<HelpGuideDefinition>;
  selectedGuideId: string;
  content: string;
}

export default function HelpViewer({ guides, selectedGuideId, content }: HelpViewerProps) {
  const fileNameToGuideId = new Map(
    guides.map((guide) => [guide.relativeDocPath.split('/').pop(), guide.id])
  );

  function mapHelpHref(href?: string): string | undefined {
    if (!href) return href;
    if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('#')) {
      return href;
    }

    const fileName = href.split('/').pop();
    if (!fileName) return href;

    const guideId = fileNameToGuideId.get(fileName);
    if (!guideId) return href;

    return `/help?guide=${guideId}`;
  }

  return (
    <div className="flex-1 min-h-0 overflow-hidden">
      <div className="max-w-7xl mx-auto h-full px-4 py-6 grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-6">
        <aside className="app-card lg:h-[calc(100vh-140px)] overflow-auto rounded-2xl p-3">
          <h2 className="mb-2 text-sm font-semibold text-[color:var(--brand-strong)]">Help Topics</h2>
          <ul className="space-y-1">
            {guides.map((guide) => {
              const selected = guide.id === selectedGuideId;
              return (
                <li key={guide.id}>
                  <Link
                    href={`/help?guide=${guide.id}`}
                    className={`block rounded-lg px-3 py-2 transition-colors border ${
                      selected
                        ? 'bg-[color:var(--brand-soft)] text-[color:var(--brand-strong)] border-[color:var(--brand)]/40'
                        : 'text-slate-600 border-transparent hover:text-[color:var(--brand-strong)] hover:bg-[color:var(--surface-muted)]'
                    }`}
                  >
                    <div className="text-sm font-medium">{guide.title}</div>
                    <div className="mt-0.5 text-xs text-slate-500">{guide.description}</div>
                  </Link>
                </li>
              );
            })}
          </ul>
        </aside>

        <section className="app-card lg:h-[calc(100vh-140px)] overflow-auto rounded-2xl p-6">
          <div className="prose prose-sm max-w-none prose-headings:scroll-mt-24 prose-headings:text-[color:var(--brand-strong)] prose-a:text-[color:var(--brand)] prose-pre:bg-[color:var(--surface-muted)] prose-pre:border prose-pre:border-[color:var(--line)] prose-code:text-[color:var(--brand-strong)]">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ href, children, ...props }) => {
                  const mappedHref = mapHelpHref(href);
                  if (!mappedHref) return <a {...props}>{children}</a>;

                  if (mappedHref.startsWith('http://') || mappedHref.startsWith('https://')) {
                    return (
                      <a href={mappedHref} target="_blank" rel="noopener noreferrer" {...props}>
                        {children}
                      </a>
                    );
                  }

                  return (
                    <Link href={mappedHref} {...props}>
                      {children}
                    </Link>
                  );
                },
              }}
            >
              {content}
            </ReactMarkdown>
          </div>
        </section>
      </div>
    </div>
  );
}
