import { useEffect, useRef, useState } from 'react';
import { cn } from '../lib/utils';

interface DependencyGraphProps {
  definition: string;
  className?: string;
}

export function DependencyGraph({ definition, className }: DependencyGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const theme = document.documentElement.classList.contains('dark') ? 'dark' : 'default';

  useEffect(() => {
    let cancelled = false;

    async function renderGraph() {
      if (!containerRef.current) return;

      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({
          startOnLoad: false,
          theme,
        });

        if (cancelled) return;

        const id = `mermaid-${Date.now()}`;
        const { svg } = await mermaid.render(id, definition);

        if (cancelled || !containerRef.current) return;
        containerRef.current.innerHTML = svg;
        setLoading(false);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to render graph');
          setLoading(false);
        }
      }
    }

    setLoading(true);
    setError(null);
    renderGraph();

    return () => {
      cancelled = true;
    };
  }, [definition, theme]);

  if (error) {
    return (
      <div className={cn('rounded-lg border border-border bg-card p-4', className)}>
        <p className="text-sm text-red-400">Failed to render dependency graph: {error}</p>
        <pre className="mt-2 text-xs text-muted-foreground overflow-auto">{definition}</pre>
      </div>
    );
  }

  return (
    <div className={cn('rounded-lg border border-border bg-card p-4', className)}>
      {loading && (
        <p className="text-sm text-muted-foreground">Loading graph...</p>
      )}
      <div ref={containerRef} className="overflow-auto" />
    </div>
  );
}
