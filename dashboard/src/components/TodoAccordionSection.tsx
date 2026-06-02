import type { DragEvent, ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../lib/utils';

interface TodoAccordionSectionProps {
  label: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  /** Highlights the section as the active drop target during a drag. */
  isDropTarget?: boolean;
  onDragOver?: (e: DragEvent<HTMLElement>) => void;
  onDragLeave?: (e: DragEvent<HTMLElement>) => void;
  onDrop?: (e: DragEvent<HTMLElement>) => void;
  children: ReactNode;
}

// Presentational collapsible section shell for the todos accordion. The outer
// container always wires the drag handlers so empty or collapsed sections remain
// valid drop targets. Mirrors the AssignmentsPage list-group header/drop pattern,
// but never hides an empty section.
export function TodoAccordionSection({
  label,
  count,
  expanded,
  onToggle,
  isDropTarget = false,
  onDragOver,
  onDragLeave,
  onDrop,
  children,
}: TodoAccordionSectionProps) {
  return (
    <div
      className={cn(
        'rounded-lg border border-border/60 bg-card/40 transition',
        isDropTarget && 'ring-2 ring-ring/30',
      )}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
      >
        <ChevronDown
          className={cn(
            'h-4 w-4 text-muted-foreground transition-transform',
            !expanded && '-rotate-90',
          )}
        />
        <span className="font-semibold text-foreground">{label}</span>
        <span className="rounded-full border border-border/60 px-2 py-0.5 text-xs text-muted-foreground">
          {count}
        </span>
      </button>
      {expanded && <div className="space-y-1 px-2 pb-2">{children}</div>}
    </div>
  );
}
