'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import type { CitedChunk } from '@/lib/types';
import MessageBubble from './MessageBubble';
import ProviderToggle from './ProviderToggle';
import LocalModelSelector from './LocalModelSelector';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sources?: CitedChunk[];
  isStreaming?: boolean;
  routingMeta?: string;
}

type AnswerMode = 'lmstudio_only' | 'anthropic_only' | 'two_tier_auto';
type ResponseProfile = 'quick' | 'balanced' | 'deep' | 'custom';

function deriveResponseProfile(
  answerStyle: 'concise' | 'detailed',
  modelTier: 'default' | 'quality',
): ResponseProfile {
  if (answerStyle === 'concise' && modelTier === 'default') return 'quick';
  if (answerStyle === 'detailed' && modelTier === 'default') return 'balanced';
  if (answerStyle === 'detailed' && modelTier === 'quality') return 'deep';
  return 'custom';
}

function applyResponseProfile(
  profile: Exclude<ResponseProfile, 'custom'>,
  setAnswerStyle: (style: 'concise' | 'detailed') => void,
  setModelTier: (tier: 'default' | 'quality') => void,
): void {
  if (profile === 'quick') {
    setAnswerStyle('concise');
    setModelTier('default');
    return;
  }
  if (profile === 'balanced') {
    setAnswerStyle('detailed');
    setModelTier('default');
    return;
  }
  setAnswerStyle('detailed');
  setModelTier('quality');
}

function generateId() {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export default function ChatContainer() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [modelTier, setModelTier] = useState<'default' | 'quality'>('default');
  const [answerMode, setAnswerMode] = useState<AnswerMode>('two_tier_auto');
  const [lmStudioModels, setLmStudioModels] = useState<string[]>([]);
  const [lmStudioModel, setLmStudioModel] = useState('');
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [modelDiscoveryError, setModelDiscoveryError] = useState<string | null>(null);
  const [answerStyle, setAnswerStyle] = useState<'concise' | 'detailed'>('concise');
  const [error, setError] = useState<string | null>(null);
  const [providerNotice, setProviderNotice] = useState<string | null>(null);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const responseAnchorIdRef = useRef<string | null>(null);

  const scrollToResponseTop = useCallback(() => {
    const anchorId = responseAnchorIdRef.current;
    if (!anchorId) return;

    const anchor = document.getElementById(anchorId);
    if (!anchor) return;

    anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
    responseAnchorIdRef.current = null;
  }, []);

  const handleStop = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsLoading(false);
  }, []);

  useEffect(() => {
    scrollToResponseTop();
  }, [messages, scrollToResponseTop]);

  const responseProfile = deriveResponseProfile(answerStyle, modelTier);

  // Cleanup abort controller on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadModels() {
      setIsLoadingModels(true);
      setModelDiscoveryError(null);
      try {
        const response = await fetch('/api/models');
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload?.error || 'Unable to load LM Studio models');
        }

        if (cancelled) return;
        const ids = Array.isArray(payload.models)
          ? payload.models
            .map((entry: { id?: string }) => entry?.id)
            .filter((id: string | undefined): id is string => typeof id === 'string' && id.length > 0)
          : [];

        setLmStudioModels(ids);

        if (typeof payload.answerMode === 'string') {
          const mode = payload.answerMode as AnswerMode;
          if (mode === 'lmstudio_only' || mode === 'anthropic_only' || mode === 'two_tier_auto') {
            setAnswerMode(mode);
          }
        }

        const preferred = typeof payload.defaultLmStudioModel === 'string' ? payload.defaultLmStudioModel : '';
        const selected = preferred && ids.includes(preferred) ? preferred : (ids[0] ?? '');
        setLmStudioModel((prev) => (prev && ids.includes(prev) ? prev : selected));
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Unable to load LM Studio models';
        setModelDiscoveryError(message);
      } finally {
        if (!cancelled) {
          setIsLoadingModels(false);
        }
      }
    }

    void loadModels();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed || isLoading) return;

    setError(null);
    setProviderNotice(null);

    const userMessage: Message = {
      id: generateId(),
      role: 'user',
      content: trimmed,
    };

    const assistantId = generateId();
    const assistantMessage: Message = {
      id: assistantId,
      role: 'assistant',
      content: '',
      sources: [],
      isStreaming: true,
    };

    responseAnchorIdRef.current = `message-${assistantId}`;
    setMessages((prev) => [...prev, userMessage, assistantMessage]);
    setInput('');
    setIsLoading(true);

    // Build conversation history (exclude the new messages we just added)
    const conversationHistory = messages
      .filter((m) => !m.isStreaming)
      .map((m) => ({ role: m.role, content: m.content }));

    try {
      // Create a new abort controller for this request
      abortControllerRef.current = new AbortController();
      
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: trimmed,
          conversationHistory,
          modelTier,
          answerMode,
          lmStudioModel: answerMode === 'anthropic_only' ? undefined : lmStudioModel,
          answerStyle,
        }),
        signal: abortControllerRef.current.signal,
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Request failed (${response.status}): ${errText}`);
      }

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Split on double newlines to get complete SSE events
        const events = buffer.split('\n\n');
        buffer = events.pop()!; // last element may be incomplete

        for (const event of events) {
          if (!event.trim()) continue;

          const lines = event.split('\n');
          const eventLine = lines.find((l) => l.startsWith('event:'));
          const dataLine = lines.find((l) => l.startsWith('data:'));

          if (!eventLine || !dataLine) continue;

          const eventType = eventLine.replace('event: ', '').trim();
          const dataStr = dataLine.replace('data: ', '');

          try {
            const parsed = JSON.parse(dataStr);

            switch (eventType) {
              case 'sources':
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantId ? { ...m, sources: parsed.chunks } : m
                  )
                );
                break;

              case 'provider': {
                if (
                  parsed?.fallbackApplied === true
                  && (parsed?.requested === 'anthropic_only' || parsed?.requested === 'anthropic')
                  && parsed?.resolved === 'lmstudio'
                ) {
                  setProviderNotice('Claude is disabled in environment; using LM Studio for this response.');
                }
                break;
              }

              case 'routing': {
                if (typeof parsed?.provider_used === 'string' && typeof parsed?.model_used === 'string') {
                  const meta = `${parsed.provider_used} · ${parsed.model_used}`;
                  setMessages((prev) =>
                    prev.map((m) =>
                      m.id === assistantId ? { ...m, routingMeta: meta } : m
                    )
                  );
                }
                break;
              }

              case 'token':
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantId
                      ? { ...m, content: m.content + parsed.text }
                      : m
                  )
                );
                break;

              case 'done':
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantId ? { ...m, isStreaming: false } : m
                  )
                );
                break;

              case 'error': {
                const errMsg = parsed.message || 'An error occurred';
                setError(errMsg);
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantId
                      ? { ...m, isStreaming: false, content: m.content || errMsg }
                      : m
                  )
                );
                break;
              }
            }
          } catch {
            // Skip malformed JSON
          }
        }
      }

      // Ensure streaming is marked done even if no done event was received
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId ? { ...m, isStreaming: false } : m
        )
      );
    } catch (err) {
      // Handle abort separately
      if (err instanceof DOMException && err.name === 'AbortError') {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, isStreaming: false, content: m.content || '[Response stopped by user]' }
              : m
          )
        );
      } else {
        const message = err instanceof Error ? err.message : 'Failed to send message';
        setError(message);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, isStreaming: false, content: m.content || 'Failed to get response.' }
              : m
          )
        );
      }
    } finally {
      abortControllerRef.current = null;
      setIsLoading(false);
      inputRef.current?.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-7xl flex-1 flex-col px-3 py-4 sm:px-4 sm:py-5">
      {/* Header bar with model toggle */}
      <div className="app-card flex flex-wrap items-center justify-between gap-3 rounded-t-2xl border-b px-4 py-3">
        <span className="text-xs text-slate-500">
          {messages.length === 0 ? 'Start a conversation' : `${messages.filter((m) => m.role === 'user').length} messages`}
        </span>
        <div className="flex flex-wrap items-center gap-2 overflow-x-auto">
          <label className="flex items-center gap-2 text-xs text-slate-500">
            <span className="hidden sm:inline">Response profile</span>
            <select
              value={responseProfile}
              onChange={(e) => {
                const selected = e.target.value as ResponseProfile;
                if (selected === 'custom') return;
                applyResponseProfile(selected, setAnswerStyle, setModelTier);
              }}
              className="app-input rounded-md px-2 py-1 text-slate-700"
            >
              <option value="quick">Quick (short + fast model)</option>
              <option value="balanced">Balanced (detailed + fast model)</option>
              <option value="deep">Deep (detailed + quality model)</option>
              {responseProfile === 'custom' && <option value="custom">Custom</option>}
            </select>
          </label>
          <ProviderToggle providerMode={answerMode} onChange={setAnswerMode} />
          <LocalModelSelector
            models={lmStudioModels}
            value={lmStudioModel}
            loading={isLoadingModels}
            disabled={answerMode === 'anthropic_only'}
            onChange={setLmStudioModel}
          />
        </div>
        <div className="w-full text-[11px] text-slate-500 sm:text-xs">
          Quick = concise answer using fast model. Balanced = detailed answer using fast model. Deep = detailed answer using quality model.
        </div>
      </div>

      {modelDiscoveryError && !error && (
        <div className="mx-2 mt-2 flex items-center justify-between rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-700 sm:mx-4">
          <span>{modelDiscoveryError}</span>
          <button
            onClick={() => setModelDiscoveryError(null)}
            className="ml-2 text-amber-600 hover:text-amber-800"
          >
            x
          </button>
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="mx-2 mt-2 flex items-center justify-between rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 sm:mx-4">
          <span>{error}</span>
          <button
            onClick={() => setError(null)}
            className="ml-2 text-red-500 hover:text-red-700"
          >
            x
          </button>
        </div>
      )}

      {providerNotice && !error && (
        <div className="mx-2 mt-2 flex items-center justify-between rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-700 sm:mx-4">
          <span>{providerNotice}</span>
          <button
            onClick={() => setProviderNotice(null)}
            className="ml-2 text-amber-600 hover:text-amber-800"
          >
            x
          </button>
        </div>
      )}

      {/* Messages area */}
      <div className="app-card flex-1 overflow-y-auto border-t-0 px-4 py-4 sm:px-5">
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center rounded-2xl border border-dashed border-[color:var(--line)] bg-[color:var(--surface-muted)] text-center text-slate-600">
            <div className="mb-4 grid h-16 w-16 place-items-center rounded-2xl bg-[color:var(--brand)] text-lg font-extrabold text-white">
              NZ
            </div>
            <p className="text-lg font-semibold text-[color:var(--brand-strong)]">IDD Knowledge Chat</p>
            <p className="mt-1 max-w-md text-sm text-slate-500">
              Ask practical questions about manuals, procedures, and policy sources.
            </p>
          </div>
        )}
        {messages.map((msg) => (
          <div key={msg.id} id={`message-${msg.id}`}>
            <MessageBubble
              role={msg.role}
              content={msg.content}
              sources={msg.sources}
              isStreaming={msg.isStreaming}
              routingMeta={msg.routingMeta}
            />
          </div>
        ))}
      </div>

      {/* Input area */}
      <div className="app-card rounded-b-2xl border-t-0 px-4 py-3">
        <div className="flex items-end gap-2 max-w-4xl mx-auto">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask a question about IDD documents..."
            rows={1}
            disabled={isLoading}
            className="app-input flex-1 resize-none rounded-xl px-3 py-2.5 text-sm placeholder:text-slate-400 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            style={{ maxHeight: '120px' }}
            onInput={(e) => {
              const target = e.target as HTMLTextAreaElement;
              target.style.height = 'auto';
              target.style.height = Math.min(target.scrollHeight, 120) + 'px';
            }}
          />
          {isLoading ? (
            <button
              onClick={handleStop}
              className="rounded-xl bg-red-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-red-700 active:bg-red-800"
              title="Stop the current response"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!input.trim()}
              className="rounded-xl bg-[color:var(--brand)] px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-[color:var(--brand-strong)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
