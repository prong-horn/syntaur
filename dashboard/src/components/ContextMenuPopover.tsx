import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '../lib/utils';
import type { OverflowMenuItem } from './OverflowMenu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';

interface ContextMenuPopoverProps {
  anchor: { x: number; y: number } | null;
  items: OverflowMenuItem[];
  onClose: () => void;
}

const MENU_WIDTH = 220;
const VIEWPORT_PADDING = 8;

export function ContextMenuPopover({ anchor, items, onClose }: ContextMenuPopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  // Position the menu so it stays inside the viewport even when right-clicked near the edge.
  useLayoutEffect(() => {
    if (!anchor) {
      setPosition(null);
      return;
    }
    const measured = ref.current;
    const width = measured?.offsetWidth ?? MENU_WIDTH;
    const height = measured?.offsetHeight ?? 0;
    const maxLeft = Math.max(VIEWPORT_PADDING, window.innerWidth - width - VIEWPORT_PADDING);
    const maxTop = Math.max(VIEWPORT_PADDING, window.innerHeight - height - VIEWPORT_PADDING);
    setPosition({
      left: Math.min(anchor.x, maxLeft),
      top: Math.min(anchor.y, maxTop),
    });
  }, [anchor]);

  useEffect(() => {
    if (!anchor) return;
    function handleMouseDown(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        onClose();
      }
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
      }
    }
    function handleScroll() {
      onClose();
    }
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKey);
    document.addEventListener('contextmenu', handleMouseDown);
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKey);
      document.removeEventListener('contextmenu', handleMouseDown);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [anchor, onClose]);

  if (!anchor || items.length === 0) return null;

  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-50 min-w-[220px] rounded-md border border-border/70 bg-background py-1 shadow-lg"
      style={{
        left: position?.left ?? anchor.x,
        top: position?.top ?? anchor.y,
        visibility: position ? 'visible' : 'hidden',
      }}
    >
      <TooltipProvider delayDuration={200}>
        {items.map((item) => {
          const Icon = item.icon;
          const rowClass = cn(
            'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition',
            item.disabled
              ? 'cursor-not-allowed opacity-50'
              : item.destructive
                ? 'text-destructive hover:bg-destructive/10'
                : 'hover:bg-foreground/5',
          );
          const content = (
            <>
              {Icon ? <Icon className="h-4 w-4 shrink-0" /> : null}
              <span className="block min-w-0 truncate">{item.label}</span>
            </>
          );

          if (item.disabled) {
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
                onClick={() => onClose()}
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
                onClose();
              }}
            >
              {content}
            </button>
          );
        })}
      </TooltipProvider>
    </div>
  );
}
