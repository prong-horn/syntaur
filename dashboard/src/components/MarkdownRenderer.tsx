import ReactMarkdown from 'react-markdown';
import { cn } from '../lib/utils';

interface MarkdownRendererProps {
  content: string;
  className?: string;
  emptyState?: string;
}

export function MarkdownRenderer({
  content,
  className,
  emptyState = 'No markdown content yet.',
}: MarkdownRendererProps) {
  if (!content.trim()) {
    return (
      <div className="rounded-md border border-dashed border-border/80 bg-muted/30 px-3 py-4 text-sm text-muted-foreground">
        {emptyState}
      </div>
    );
  }

  return (
    <div className={cn('prose-syntaur max-w-none', className)}>
      <ReactMarkdown>{content}</ReactMarkdown>
    </div>
  );
}
