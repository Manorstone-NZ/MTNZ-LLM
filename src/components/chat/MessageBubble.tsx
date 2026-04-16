'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { CitedChunk } from '@/lib/types';
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

/** Replace [Source: X] patterns with badge components */
function renderContentWithBadges(content: string) {
  // Split on [Source: ...] patterns
  const parts = content.split(/(\[Source:\s*[^\]]+\])/g);
  if (parts.length === 1) return content;

  const processed = parts
    .map((part) => {
      const match = part.match(/^\[Source:\s*([^\]]+)\]$/);
      if (match) {
        // Replace with a placeholder that won't be parsed as markdown
        return `<source-badge label="${match[1].trim()}" />`;
      }
      return part;
    })
    .join('');

  return processed;
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
  const processedContent = renderContentWithBadges(content);

  return (
    <div className="flex justify-start mb-4">
      <div className="max-w-[85%]">
        <div className="px-4 py-2.5 rounded-2xl rounded-bl-md bg-slate-800 text-slate-100 text-sm leading-relaxed prose prose-invert prose-sm max-w-none prose-p:my-1.5 prose-headings:my-2 prose-li:my-0.5 prose-pre:bg-slate-900 prose-pre:border prose-pre:border-slate-700 prose-code:text-blue-300 prose-table:text-xs prose-th:px-2 prose-th:py-1 prose-td:px-2 prose-td:py-1 prose-th:border prose-th:border-slate-600 prose-td:border prose-td:border-slate-700">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              // Custom renderer to handle source badges
              p: ({ children, ...props }) => {
                if (typeof children === 'string' && children.includes('<source-badge')) {
                  const parts = children.split(/(<source-badge label="[^"]*" \/>)/g);
                  return (
                    <p {...props}>
                      {parts.map((part, i) => {
                        const match = part.match(/^<source-badge label="([^"]*)" \/>$/);
                        if (match) {
                          return <SourceBadge key={i} label={match[1]} />;
                        }
                        return part;
                      })}
                    </p>
                  );
                }
                return <p {...props}>{children}</p>;
              },
            }}
          >
            {processedContent}
          </ReactMarkdown>
          {isStreaming && (
            <span className="inline-block w-2 h-4 ml-0.5 bg-blue-400 animate-pulse rounded-sm" />
          )}
        </div>
        {sources && sources.length > 0 && <SourceCard sources={sources} />}
      </div>
    </div>
  );
}
