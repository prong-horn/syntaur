import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

interface CopyButtonProps {
  value: string;
  label?: string;
  disabled?: boolean;
  disabledReason?: string;
  /** Called when clipboard write fails or the API is unavailable. */
  onError?: (error: Error) => void;
}

export function CopyButton({
  value,
  label,
  disabled = false,
  disabledReason,
  onError,
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    if (disabled) return;
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
        throw new Error('Clipboard API is unavailable in this context.');
      }
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  if (disabled) {
    return (
      <button
        type="button"
        disabled
        aria-disabled="true"
        className="cursor-not-allowed text-muted-foreground/50"
        title={disabledReason ?? 'Copy unavailable'}
        aria-label={label ?? 'Copy'}
      >
        <Copy className="h-3 w-3" aria-hidden="true" />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 rounded"
      title={copied ? 'Copied!' : (label ?? `Copy: ${value}`)}
      aria-label={label ?? 'Copy'}
    >
      {copied
        ? <Check className="h-3 w-3 text-status-completed-foreground" aria-hidden="true" />
        : <Copy className="h-3 w-3" aria-hidden="true" />}
    </button>
  );
}
