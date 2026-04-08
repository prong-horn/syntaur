import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { cn } from '../lib/utils';

interface DependencyGraphProps {
  definition: string;
  className?: string;
  nodeRoutes?: Record<string, string>;
}

export function DependencyGraph({ definition, className, nodeRoutes = {} }: DependencyGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();
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
        wireNodeLinks(containerRef.current, nodeRoutes, navigate);
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
  }, [definition, navigate, nodeRoutes, theme]);

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

function wireNodeLinks(
  container: HTMLDivElement,
  nodeRoutes: Record<string, string>,
  navigate: (to: string) => void,
) {
  for (const node of container.querySelectorAll<SVGGElement>('.node')) {
    const label = node.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    const route = nodeRoutes[label];
    if (!route) {
      continue;
    }

    node.style.cursor = 'pointer';
    node.setAttribute('role', 'link');
    node.setAttribute('tabindex', '0');
    node.setAttribute('aria-label', `Open ${label}`);

    const handleActivate = () => navigate(route);
    node.addEventListener('click', handleActivate);
    node.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        handleActivate();
      }
    });
  }
}
