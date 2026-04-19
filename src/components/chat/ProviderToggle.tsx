'use client';

interface ProviderToggleProps {
  providerMode: 'auto' | 'anthropic' | 'lmstudio';
  onChange: (mode: 'auto' | 'anthropic' | 'lmstudio') => void;
}

const OPTIONS: Array<{ value: 'auto' | 'anthropic' | 'lmstudio'; label: string }> = [
  { value: 'auto', label: 'Provider: Auto' },
  { value: 'anthropic', label: 'Provider: Claude' },
  { value: 'lmstudio', label: 'Provider: LM Studio' },
];

export default function ProviderToggle({ providerMode, onChange }: ProviderToggleProps) {
  return (
    <label className="text-xs text-slate-400 flex items-center gap-2">
      <span className="hidden sm:inline">Model Provider</span>
      <select
        value={providerMode}
        onChange={(e) => onChange(e.target.value as 'auto' | 'anthropic' | 'lmstudio')}
        className="rounded-md bg-slate-800 border border-slate-700 text-slate-200 px-2 py-1 focus:outline-none focus:border-blue-500"
      >
        {OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  );
}
