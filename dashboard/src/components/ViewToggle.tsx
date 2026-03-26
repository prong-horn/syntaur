import { cn } from '../lib/utils';

interface ViewToggleOption {
  value: string;
  label: string;
}

interface ViewToggleProps {
  value: string;
  options: ViewToggleOption[];
  onChange: (value: string) => void;
}

export function ViewToggle({ value, options, onChange }: ViewToggleProps) {
  return (
    <div className="inline-flex rounded-md border border-border/60 bg-background/80 p-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            'rounded-sm px-2.5 py-1.5 text-sm font-medium transition',
            value === option.value
              ? 'bg-foreground text-background'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
