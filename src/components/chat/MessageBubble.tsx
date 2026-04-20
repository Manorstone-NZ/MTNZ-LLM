'use client';

import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { CitedChunk } from '@/lib/types';
import { shouldShowSources } from '@/lib/citations';
import { formatAssistantContent } from './messageFormatting';
import { buildInlineImagePreviews } from './imagePreview';
import SourceCard from './SourceCard';

interface MessageBubbleProps {
  role: 'user' | 'assistant';
  content: string;
  sources?: CitedChunk[];
  isStreaming?: boolean;
  routingMeta?: string;
}

function SourceBadge({ label }: { label: string }) {
  return (
    <span className="mx-0.5 inline-flex items-center rounded border border-[color:var(--line)] bg-[color:var(--brand-soft)] px-1.5 py-0.5 text-[10px] font-semibold text-[color:var(--brand-strong)]">
      {label}
    </span>
  );
}

function renderFormattedNodes(children: React.ReactNode): React.ReactNode {
  return React.Children.map(children, (child, index) => {
    if (typeof child === 'string') {
      const parts = child.split(/(<source-badge label="[^"]*" \/>|<line-break \/>)/g);
      return parts.map((part, partIndex) => {
        if (!part) return null;

        const badgeMatch = part.match(/^<source-badge label="([^"]*)" \/>$/);
        if (badgeMatch) {
          return <SourceBadge key={`${index}-${partIndex}`} label={badgeMatch[1]} />;
        }

        if (part === '<line-break />') {
          return <br key={`${index}-${partIndex}`} />;
        }

        return part;
      });
    }

    return child;
  });
}

export default function MessageBubble({ role, content, sources, isStreaming, routingMeta }: MessageBubbleProps) {
  if (role === 'user') {
    return (
      <div className="flex justify-end mb-4">
        <div className="max-w-[75%] rounded-2xl rounded-br-md bg-[color:var(--brand)] px-4 py-2.5 text-sm leading-relaxed text-white shadow-sm">
          {content}
        </div>
      </div>
    );
  }

  // Assistant message
  const processedContent = formatAssistantContent(content);
  const showSources = shouldShowSources(content, sources);
  const imagePreviews = buildInlineImagePreviews(sources);

  return (
    <div className="flex justify-start mb-4">
      <div className="max-w-[85%]">
        <div className="app-card rounded-2xl rounded-bl-md px-4 py-2.5 text-sm leading-relaxed text-slate-700 prose prose-sm max-w-none prose-p:my-1.5 prose-headings:my-2 prose-li:my-0.5 prose-pre:border prose-pre:border-[color:var(--line)] prose-pre:bg-[color:var(--surface-muted)] prose-code:text-[color:var(--brand-strong)] prose-table:text-xs prose-th:px-2 prose-th:py-1 prose-td:px-2 prose-td:py-1 prose-th:border prose-th:border-[color:var(--line)] prose-td:border prose-td:border-[color:var(--line)] [&_h2+ul]:space-y-1">
          {content.length === 0 && isStreaming ? (
            <div className="flex items-center gap-2">
              <span className="inline-block w-2 h-2 bg-[color:var(--brand)] rounded-full animate-pulse" />
              <span className="text-slate-500">Generating response...</span>
            </div>
          ) : (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                p: ({ children, ...props }) => <p {...props}>{renderFormattedNodes(children)}</p>,
                td: ({ children, ...props }) => <td {...props}>{renderFormattedNodes(children)}</td>,
                li: ({ children, ...props }) => <li {...props} className="break-words">{renderFormattedNodes(children)}</li>,
              }}
            >
              {processedContent}
            </ReactMarkdown>
          )}
          {imagePreviews.length > 0 && (
            <div className="mt-3 space-y-2">
              {imagePreviews.map((preview) => (
                <figure
                  key={preview.documentId}
                  className="overflow-hidden rounded-lg border border-[color:var(--line)] bg-white"
                >
                  <img
                    src={preview.previewUrl}
                    alt={preview.title}
                    className="h-auto max-h-80 w-full object-contain bg-[color:var(--surface-muted)]"
                    loading="lazy"
                  />
                  <figcaption className="border-t border-[color:var(--line)] px-3 py-2 text-xs text-slate-500">
                    <span className="text-slate-700">{preview.title}</span>
                    {preview.sectionTitle ? (
                      <>
                        <span className="mx-1 text-slate-400">-</span>
                        <span>{preview.sectionTitle}</span>
                      </>
                    ) : null}
                  </figcaption>
                </figure>
              ))}
            </div>
          )}
          {isStreaming && (
            <span className="ml-0.5 inline-block h-4 w-2 animate-pulse rounded-sm bg-[color:var(--accent)]" />
          )}
        </div>
        {showSources && <SourceCard sources={sources!} />}
        {routingMeta && !isStreaming && (
          <p className="mt-1 text-[10px] text-slate-400">{routingMeta}</p>
        )}
      </div>
    </div>
  );
}
