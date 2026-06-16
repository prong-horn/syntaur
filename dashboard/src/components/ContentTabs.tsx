import * as Tabs from '@radix-ui/react-tabs';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '../lib/utils';

interface TabItem {
  value: string;
  label: string;
  count?: number;
  problemCount?: number;
  content: ReactNode;
}

interface ContentTabsProps {
  value: string;
  onValueChange: (value: string) => void;
  items: TabItem[];
  className?: string;
}

export function ContentTabs({
  value,
  onValueChange,
  items,
  className,
}: ContentTabsProps) {
  const listRef = useRef<HTMLDivElement>(null);
  // When the tab strip overflows horizontally, show a right-edge fade so the
  // hidden/cut-off tabs are discoverable (the native scrollbar auto-hides on
  // macOS, and the previously-applied scrollbar-hiding utility class was a
  // no-op that injected nothing).
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    updateScroll();
    el.addEventListener('scroll', updateScroll, { passive: true });
    const ro = new ResizeObserver(updateScroll);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', updateScroll);
      ro.disconnect();
    };
  }, [updateScroll, items.length]);

  return (
    <Tabs.Root value={value} onValueChange={onValueChange} className={className}>
      <div className="relative">
        <Tabs.List
          ref={listRef}
          className="flex gap-2 overflow-x-auto rounded-md border border-border/70 bg-card/80 p-1"
        >
          {items.map((item) => (
            <Tabs.Trigger
              key={item.value}
              value={item.value}
              className={cn(
                'inline-flex items-center gap-2 rounded-sm px-3 py-1.5 text-sm font-medium text-muted-foreground transition',
                'data-[state=active]:bg-foreground data-[state=active]:text-background',
              )}
            >
              <span>{item.label}</span>
              {typeof item.count === 'number' ? (
                <span className="rounded-full bg-background/20 px-2 py-0.5 text-xs data-[state=active]:bg-background/20">
                  {item.count}
                </span>
              ) : null}
              {item.problemCount && item.problemCount > 0 ? (
                <span
                  className="rounded-full bg-destructive/15 px-2 py-0.5 text-xs text-destructive"
                  aria-label={`${item.problemCount} ${item.problemCount === 1 ? 'error' : 'errors'}`}
                  title={`${item.problemCount} ${item.problemCount === 1 ? 'error' : 'errors'}`}
                >
                  {item.problemCount}
                </span>
              ) : null}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        {canScrollRight ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 right-0 w-8 rounded-r-md bg-gradient-to-l from-card to-transparent"
          />
        ) : null}
      </div>

      {items.map((item) => (
        <Tabs.Content key={item.value} value={item.value} className="pt-3">
          {item.content}
        </Tabs.Content>
      ))}
    </Tabs.Root>
  );
}
