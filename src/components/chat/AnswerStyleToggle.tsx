'use client';

interface AnswerStyleToggleProps {
  answerStyle: 'concise' | 'detailed';
  onChange: (style: 'concise' | 'detailed') => void;
}

export default function AnswerStyleToggle({ answerStyle, onChange }: AnswerStyleToggleProps) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <button
        onClick={() => onChange('concise')}
        className={`px-3 py-1 rounded-l-md border transition-colors ${
          answerStyle === 'concise'
            ? 'bg-[color:var(--accent)] border-[color:var(--accent)] text-white'
            : 'bg-white border-[color:var(--line)] text-slate-600 hover:text-[color:var(--brand-strong)]'
        }`}
      >
        Concise
      </button>
      <button
        onClick={() => onChange('detailed')}
        className={`px-3 py-1 rounded-r-md border border-l-0 transition-colors ${
          answerStyle === 'detailed'
            ? 'bg-[color:var(--accent)] border-[color:var(--accent)] text-white'
            : 'bg-white border-[color:var(--line)] text-slate-600 hover:text-[color:var(--brand-strong)]'
        }`}
      >
        Detailed
      </button>
    </div>
  );
}
