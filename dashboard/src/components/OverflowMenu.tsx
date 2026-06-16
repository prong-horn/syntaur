import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { MoreHorizontal, Check, ChevronRight, ChevronDown } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../lib/utils';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';

export interface OverflowMenuItem {
  key: string;
  label: string;
  icon?: LucideIcon;
  onSelect?: () => void;
  href?: string;
  disabled?: boolean;
  disabledReason?: string;
  destructive?: boolean;
  // When set, this item is a one-level submenu parent: clicking it toggles an
  // inline expansion of `submenu` rather than selecting it. Children render
  // indented and reuse the same row rendering (icon/href/disabled/destructive).
  submenu?: OverflowMenuItem[];
  // For a submenu child: render a leading checkmark to mark the current choice.
  // Ignored on top-level non-submenu items. Does not disable the row.
  active?: boolean;
}

interface OverflowMenuProps {
  items: OverflowMenuItem[];
  align?: 'start' | 'end';
}

export function OverflowMenu({ items, align = 'end' }: OverflowMenuProps) {
  const [open, setOpen] = useState(false);
  // Which submenu (by key) is currently expanded; at most one at a time.
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      // Collapse any open submenu whenever the whole menu closes.
      setExpandedKey(null);
      return;
    }
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  if (items.length === 0) return null;

  // Renders a single actionable row (button / link / disabled). Shared by
  // top-level items and submenu children. `isChild` indents the row and swaps
  // the leading slot for an active checkmark (or an aligned spacer).
  function renderActionRow(item: OverflowMenuItem, isChild: boolean): ReactNode {
    const Icon = item.icon;
    const rowClass = cn(
      'flex w-full items-center gap-2 px-3 py-1.5 text-sm text-left transition',
      isChild && 'pl-8',
      item.disabled
        ? 'opacity-50 cursor-not-allowed'
        : item.destructive
          ? 'text-destructive hover:bg-destructive/10'
          : 'hover:bg-foreground/5',
    );

    const leading = isChild ? (
      item.active ? (
        <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
      ) : (
        <span className="h-4 w-4 shrink-0" aria-hidden="true" />
      )
    ) : Icon ? (
      <Icon className="h-4 w-4 shrink-0" />
    ) : null;

    const content = (
      <>
        {leading}
        <span className="block min-w-0 truncate">{item.label}</span>
      </>
    );

    if (item.disabled) {
      // Disabled <button> elements don't emit hover/focus events reliably across
      // browsers, so wrap them in a focusable span to trigger the Radix tooltip.
      const disabledRow = (
        <span tabIndex={0} className="inline-block w-full outline-none focus-visible:ring-1 focus-visible:ring-ring">
          <button type="button" disabled className={rowClass}>
            {content}
          </button>
        </span>
      );

      if (item.disabledReason) {
        return (
          <Tooltip key={item.key}>
            <TooltipTrigger asChild>{disabledRow}</TooltipTrigger>
            <TooltipContent side="left">{item.disabledReason}</TooltipContent>
          </Tooltip>
        );
      }
      return <div key={item.key}>{disabledRow}</div>;
    }

    if (item.href) {
      return (
        <Link
          key={item.key}
          to={item.href}
          className={rowClass}
          onClick={() => setOpen(false)}
        >
          {content}
        </Link>
      );
    }

    return (
      <button
        key={item.key}
        type="button"
        className={rowClass}
        onClick={() => {
          item.onSelect?.();
          setOpen(false);
        }}
      >
        {content}
      </button>
    );
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="shell-action"
        title="More actions"
        aria-label="More actions"
        aria-haspopup="true"
        aria-expanded={open}
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open && (
        <div
          className={cn(
            'absolute top-full mt-1 z-30 min-w-[220px] rounded-md border border-border/70 bg-background shadow-lg py-1',
            align === 'end' ? 'right-0' : 'left-0',
          )}
        >
          {/*
            Intentionally not using role="menu" / role="menuitem": the full ARIA menu pattern
            requires initial focus and arrow-key navigation, which this lightweight dropdown
            doesn't implement. Announcing it as a menu without those behaviors is worse than
            leaving it as a generic popover of links/buttons.
          */}
          <TooltipProvider delayDuration={200}>
            {items.map((item) => {
              if (item.submenu && item.submenu.length > 0) {
                const Icon = item.icon;
                const expanded = expandedKey === item.key;
                return (
                  <div key={item.key}>
                    <button
                      type="button"
                      className={cn(
                        'flex w-full items-center gap-2 px-3 py-1.5 text-sm text-left transition hover:bg-foreground/5',
                      )}
                      aria-expanded={expanded}
                      onClick={() => setExpandedKey(expanded ? null : item.key)}
                    >
                      {Icon ? <Icon className="h-4 w-4 shrink-0" /> : null}
                      <span className="block min-w-0 flex-1 truncate">{item.label}</span>
                      {expanded ? (
                        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      ) : (
                        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      )}
                    </button>
                    {expanded
                      ? item.submenu.map((child) => renderActionRow(child, true))
                      : null}
                  </div>
                );
              }
              return renderActionRow(item, false);
            })}
          </TooltipProvider>
        </div>
      )}
    </div>
  );
}
