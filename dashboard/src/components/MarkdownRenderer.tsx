import ReactMarkdown from 'react-markdown';
import { cn } from '../lib/utils';

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

export function MarkdownRenderer({ content, className }: MarkdownRendererProps) {
  if (!content) {
    return <p className="text-muted-foreground text-sm italic">No content.</p>;
  }

  return (
    <div className={cn('prose prose-invert prose-sm max-w-none', className)}>
      <ReactMarkdown>{content}</ReactMarkdown>
    </div>
  );
}
