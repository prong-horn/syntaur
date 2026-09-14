import { cn } from '../lib/utils';
import { useTemplates, getTemplateDefinition } from '../hooks/useTemplates';

interface TemplateChipProps {
  template: string | null;
  className?: string;
  compact?: boolean;
}

export function TemplateChip({ template, className, compact = false }: TemplateChipProps) {
  const config = useTemplates();
  if (!template) return null;

  const definition = getTemplateDefinition(config, template);
  const label =
    definition?.label ??
    template.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  return (
    <span
      title={definition?.description ?? `Template: ${label}`}
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded-full border text-xs capitalize',
        compact ? 'px-2 py-0.5' : 'px-2.5 py-1',
        'border-border/60 text-muted-foreground',
        className,
      )}
    >
      {label}
    </span>
  );
}
