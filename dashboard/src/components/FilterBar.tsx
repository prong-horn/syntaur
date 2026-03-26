import type { ReactNode } from 'react';

export function FilterBar({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card/80 p-2.5 shadow-sm md:flex-row md:flex-wrap md:items-center">
      {children}
    </div>
  );
}
