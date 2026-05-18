import { forwardRef } from 'react';

interface OverviewFilterInputProps {
  value: string;
  onChange: (value: string) => void;
  onClear: () => void;
}

export const OverviewFilterInput = forwardRef<HTMLInputElement, OverviewFilterInputProps>(
  function OverviewFilterInput({ value, onChange, onClear }, ref) {
    return (
      <div className="flex items-center gap-2">
        <input
          ref={ref}
          type="text"
          value={value}
          placeholder="Filter (press / to focus)"
          aria-label="Filter Overview rows"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              onClear();
              (e.target as HTMLInputElement).blur();
            }
          }}
          className="w-full max-w-sm rounded-md border border-border/60 bg-background px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        {value ? (
          <button
            type="button"
            onClick={onClear}
            className="text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
          >
            Clear
          </button>
        ) : null}
      </div>
    );
  },
);
