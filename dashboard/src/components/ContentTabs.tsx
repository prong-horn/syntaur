import * as Tabs from '@radix-ui/react-tabs';
import type { ReactNode } from 'react';
import { cn } from '../lib/utils';

interface TabItem {
  value: string;
  label: string;
  count?: number;
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
  return (
    <Tabs.Root value={value} onValueChange={onValueChange} className={className}>
      <Tabs.List className="scrollbar-none flex gap-2 overflow-x-auto rounded-md border border-border/70 bg-card/80 p-1">
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
          </Tabs.Trigger>
        ))}
      </Tabs.List>

      {items.map((item) => (
        <Tabs.Content key={item.value} value={item.value} className="pt-3">
          {item.content}
        </Tabs.Content>
      ))}
    </Tabs.Root>
  );
}
