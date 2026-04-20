'use client';

interface LocalModelSelectorProps {
  models: string[];
  value: string;
  disabled?: boolean;
  loading?: boolean;
  onChange: (modelId: string) => void;
}

export default function LocalModelSelector({
  models,
  value,
  disabled,
  loading,
  onChange,
}: LocalModelSelectorProps) {
  const hasModels = models.length > 0;
  const isDisabled = Boolean(disabled) || loading || !hasModels;

  return (
    <label className="flex items-center gap-2 text-xs text-slate-500">
      <span className="hidden sm:inline">Local model</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={isDisabled}
        className="app-input rounded-md px-2 py-1 text-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
        title={!hasModels ? 'No LM Studio models discovered' : undefined}
      >
        {!hasModels && (
          <option value="">No LM Studio models</option>
        )}
        {hasModels && models.map((model) => (
          <option key={model} value={model}>
            {model}
          </option>
        ))}
      </select>
    </label>
  );
}
