import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { MoreHorizontal } from 'lucide-react';
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
}

interface OverflowMenuProps {
  items: OverflowMenuItem[];
  align?: 'start' | 'end';
}

export function OverflowMenu({ items, align = 'end' }: OverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
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

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="shell-action"
        title="More actions"
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
              const Icon = item.icon;
              const rowClass = cn(
                'flex w-full items-center gap-2 px-3 py-1.5 text-sm text-left transition',
                item.disabled
                  ? 'opacity-50 cursor-not-allowed'
                  : item.destructive
                    ? 'text-destructive hover:bg-destructive/10'
                    : 'hover:bg-foreground/5',
              );

              const content = (
                <>
                  {Icon ? <Icon className="h-4 w-4 shrink-0" /> : null}
                  <span className="truncate">{item.label}</span>
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
            })}
          </TooltipProvider>
        </div>
      )}
    </div>
  );
}
