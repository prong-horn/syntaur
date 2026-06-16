import type { ReactNode } from 'react';
import { Children, isValidElement } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import { cn } from '../lib/utils';
import { slugifyHeading } from '../lib/slugifyHeading';

interface MarkdownRendererProps {
  content: string;
  className?: string;
  emptyState?: string;
}

/** Flatten a react-markdown heading's children to plain text for slugifying. */
function nodeText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (isValidElement(node)) {
    return nodeText((node.props as { children?: ReactNode }).children);
  }
  return Children.toArray(node).map(nodeText).join('');
}

// Give each heading a stable `id` via the SHARED `slugifyHeading` (same algo as
// the backend `src/search/route.ts`) so palette deep-links like `#my-heading`
// resolve to a real element id.
const components: Components = {
  h1: ({ children, ...props }) => (
    <h1 id={slugifyHeading(nodeText(children))} {...props}>
      {children}
    </h1>
  ),
  h2: ({ children, ...props }) => (
    <h2 id={slugifyHeading(nodeText(children))} {...props}>
      {children}
    </h2>
  ),
  h3: ({ children, ...props }) => (
    <h3 id={slugifyHeading(nodeText(children))} {...props}>
      {children}
    </h3>
  ),
  h4: ({ children, ...props }) => (
    <h4 id={slugifyHeading(nodeText(children))} {...props}>
      {children}
    </h4>
  ),
  // h5/h6 carry ids too so the renderer covers the full h1–h6 range the backend
  // `nearestSection` regex (/^#{1,6}\s+.../) can emit — otherwise a hit under a
  // `#####`/`######` heading deep-links to a hash with no matching element.
  h5: ({ children, ...props }) => (
    <h5 id={slugifyHeading(nodeText(children))} {...props}>
      {children}
    </h5>
  ),
  h6: ({ children, ...props }) => (
    <h6 id={slugifyHeading(nodeText(children))} {...props}>
      {children}
    </h6>
  ),
};

export function MarkdownRenderer({
  content,
  className,
  emptyState = 'No markdown content yet.',
}: MarkdownRendererProps) {
  const stripped = content.replace(/<!--[\s\S]*?-->/g, '');

  if (!stripped.trim()) {
    return (
      <div className="rounded-md border border-dashed border-border/80 bg-muted/30 px-3 py-4 text-sm text-muted-foreground">
        {emptyState}
      </div>
    );
  }

  return (
    <div className={cn('prose-syntaur max-w-none', className)}>
      <ReactMarkdown components={components}>{stripped}</ReactMarkdown>
    </div>
  );
}
