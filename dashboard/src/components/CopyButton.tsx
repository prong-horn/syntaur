import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

export function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <button
      onClick={handleCopy}
      className="text-muted-foreground hover:text-foreground"
      title={copied ? 'Copied!' : `Copy: ${value}`}
    >
      {copied
        ? <Check className="h-3 w-3 text-status-completed-foreground" />
        : <Copy className="h-3 w-3" />}
    </button>
  );
}
