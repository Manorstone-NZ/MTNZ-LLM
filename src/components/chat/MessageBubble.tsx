'use client';

import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { CitedChunk } from '@/lib/types';
import { shouldShowSources } from '@/lib/citations';
import { formatAssistantContent } from './messageFormatting';
import SourceCard from './SourceCard';

interface MessageBubbleProps {
  role: 'user' | 'assistant';
  content: string;
  sources?: CitedChunk[];
  isStreaming?: boolean;
}

function SourceBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center px-1.5 py-0.5 mx-0.5 rounded text-[10px] font-semibold bg-blue-900/50 text-blue-300 border border-blue-700/50">
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

export default function MessageBubble({ role, content, sources, isStreaming }: MessageBubbleProps) {
  if (role === 'user') {
    return (
      <div className="flex justify-end mb-4">
        <div className="max-w-[75%] px-4 py-2.5 rounded-2xl rounded-br-md bg-blue-600 text-white text-sm leading-relaxed">
          {content}
        </div>
      </div>
    );
  }

  // Assistant message
  const processedContent = formatAssistantContent(content);
  const showSources = shouldShowSources(content, sources);

  return (
    <div className="flex justify-start mb-4">
      <div className="max-w-[85%]">
        <div className="px-4 py-2.5 rounded-2xl rounded-bl-md bg-slate-800 text-slate-100 text-sm leading-relaxed prose prose-invert prose-sm max-w-none prose-p:my-1.5 prose-headings:my-2 prose-li:my-0.5 prose-pre:bg-slate-900 prose-pre:border prose-pre:border-slate-700 prose-code:text-blue-300 prose-table:text-xs prose-th:px-2 prose-th:py-1 prose-td:px-2 prose-td:py-1 prose-th:border prose-th:border-slate-600 prose-td:border prose-td:border-slate-700">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              p: ({ children, ...props }) => <p {...props}>{renderFormattedNodes(children)}</p>,
              td: ({ children, ...props }) => <td {...props}>{renderFormattedNodes(children)}</td>,
              li: ({ children, ...props }) => <li {...props}>{renderFormattedNodes(children)}</li>,
            }}
          >
            {processedContent}
          </ReactMarkdown>
          {isStreaming && (
            <span className="inline-block w-2 h-4 ml-0.5 bg-blue-400 animate-pulse rounded-sm" />
          )}
        </div>
        {showSources && <SourceCard sources={sources!} />}
      </div>
    </div>
  );
}
