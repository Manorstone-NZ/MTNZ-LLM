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
            ? 'bg-blue-600 border-blue-600 text-white'
            : 'bg-transparent border-slate-600 text-slate-400 hover:text-slate-200'
        }`}
      >
        Fast
      </button>
      <button
        onClick={() => onChange('quality')}
        className={`px-3 py-1 rounded-r-md border border-l-0 transition-colors ${
          modelTier === 'quality'
            ? 'bg-blue-600 border-blue-600 text-white'
            : 'bg-transparent border-slate-600 text-slate-400 hover:text-slate-200'
        }`}
      >
        Quality
      </button>
    </div>
  );
}
