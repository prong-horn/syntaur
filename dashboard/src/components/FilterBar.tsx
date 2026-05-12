import type { ReactNode } from 'react';

export function FilterBar({ children }: { children: ReactNode }) {
  return (
    <div className="chrome-card flex flex-col gap-2 !p-2.5 md:flex-row md:flex-wrap md:items-center">
      {children}
    </div>
  );
}
