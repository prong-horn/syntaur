interface ColorPickerProps {
  value: string;
  onChange: (color: string) => void;
  /** Accessible name for the controls (e.g. "Status color"). Optional so
   *  existing call sites are unaffected; falls back to generic labels. */
  ariaLabel?: string;
}

export function ColorPicker({ value, onChange, ariaLabel }: ColorPickerProps) {
  const swatchLabel = ariaLabel ?? 'Pick a color';
  const hexLabel = ariaLabel ? `${ariaLabel} (hex)` : 'Color hex value';
  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        value={value || '#64748b'}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 w-7 shrink-0 cursor-pointer rounded-md border border-border/60 bg-transparent p-0.5"
        title="Pick a color"
        aria-label={swatchLabel}
      />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="#64748b"
        className="editor-input w-[5.5rem] font-mono text-xs"
        aria-label={hexLabel}
      />
    </div>
  );
}
