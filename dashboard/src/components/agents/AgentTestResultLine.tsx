import { Loader2 } from 'lucide-react';
import { formatTestResult } from '../../lib/agent-editor';
import { cn } from '../../lib/utils';
import type { AgentTestResult } from '../../lib/chat-types';

export interface AgentTestResultLineProps {
  testResult: AgentTestResult | 'loading' | null;
  className?: string;
}

export function AgentTestResultLine({ testResult, className }: AgentTestResultLineProps) {
  if (testResult === 'loading') {
    return (
      <p className={cn('inline-flex items-center gap-1 text-xs text-muted-foreground', className)}>
        <Loader2 className="h-3 w-3 animate-spin" />
        Testing…
      </p>
    );
  }
  if (!testResult) return null;
  return (
    <p
      className={cn(
        'text-xs',
        testResult.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400',
        className,
      )}
    >
      {formatTestResult(testResult)}
    </p>
  );
}
