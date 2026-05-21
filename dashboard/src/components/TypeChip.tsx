import { cn } from '../lib/utils';
import { useTypesConfig, getTypeDefinition } from '../hooks/useTypesConfig';

interface TypeChipProps {
  type: string | null;
  className?: string;
  /** Shorter padding for dense surfaces (table cells). */
  compact?: boolean;
}

export function TypeChip({ type, className, compact = false }: TypeChipProps) {
  const config = useTypesConfig();
  if (!type) return null;

  const definition = getTypeDefinition(config, type);
  const label =
    definition?.label ??
    type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  const colorStyle = definition?.color
    ? {
        backgroundColor: `color-mix(in oklch, ${definition.color} 18%, transparent)`,
        borderColor: `color-mix(in oklch, ${definition.color} 50%, transparent)`,
        color: definition.color,
      }
    : undefined;

  return (
    <span
      title={definition?.description ?? `Type: ${label}`}
      style={colorStyle}
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded-full border text-xs capitalize',
        compact ? 'px-2 py-0.5' : 'px-2.5 py-1',
        !colorStyle && 'border-border/60 text-muted-foreground',
        className,
      )}
    >
      {label}
    </span>
  );
}
