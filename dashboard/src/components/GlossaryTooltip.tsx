interface GlossaryTooltipProps {
  term: string;
  description: string;
}

export function GlossaryTooltip({ term, description }: GlossaryTooltipProps) {
  return (
    <span
      title={description}
      className="cursor-help rounded-full border border-border/70 bg-background/80 px-2.5 py-1 text-xs font-medium text-foreground underline decoration-dotted underline-offset-4"
    >
      {term}
    </span>
  );
}
