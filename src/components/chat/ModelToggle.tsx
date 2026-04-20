'use client';

interface ModelToggleProps {
  modelTier: 'default' | 'quality';
  onChange: (tier: 'default' | 'quality') => void;
}

export default function ModelToggle({ modelTier, onChange }: ModelToggleProps) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <button
        onClick={() => onChange('default')}
        className={`px-3 py-1 rounded-l-md border transition-colors ${
          modelTier === 'default'
            ? 'bg-[color:var(--brand)] border-[color:var(--brand)] text-white'
            : 'bg-white border-[color:var(--line)] text-slate-600 hover:text-[color:var(--brand-strong)]'
        }`}
      >
        Fast
      </button>
      <button
        onClick={() => onChange('quality')}
        className={`px-3 py-1 rounded-r-md border border-l-0 transition-colors ${
          modelTier === 'quality'
            ? 'bg-[color:var(--brand)] border-[color:var(--brand)] text-white'
            : 'bg-white border-[color:var(--line)] text-slate-600 hover:text-[color:var(--brand-strong)]'
        }`}
      >
        Quality
      </button>
    </div>
  );
}
