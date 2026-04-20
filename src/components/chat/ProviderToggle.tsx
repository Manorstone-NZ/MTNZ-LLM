'use client';

interface ProviderToggleProps {
  providerMode: 'lmstudio_only' | 'anthropic_only' | 'two_tier_auto';
  onChange: (mode: 'lmstudio_only' | 'anthropic_only' | 'two_tier_auto') => void;
}

const OPTIONS: Array<{ value: 'lmstudio_only' | 'anthropic_only' | 'two_tier_auto'; label: string }> = [
  { value: 'lmstudio_only', label: 'LM Studio only' },
  { value: 'anthropic_only', label: 'Claude only' },
  { value: 'two_tier_auto', label: 'Auto (two-tier)' },
];

export default function ProviderToggle({ providerMode, onChange }: ProviderToggleProps) {
  return (
    <label className="flex items-center gap-2 text-xs text-slate-500">
      <span className="hidden sm:inline">Model routing</span>
      <select
        value={providerMode}
        onChange={(e) => onChange(e.target.value as 'lmstudio_only' | 'anthropic_only' | 'two_tier_auto')}
        className="app-input rounded-md px-2 py-1 text-slate-700"
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
