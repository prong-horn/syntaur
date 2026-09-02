import { useMemo, useState } from 'react';
import { cn } from '../../lib/utils';
import { capRawIo, prettyJson, stripAnsi, toDiffLines } from '../../lib/chat-blocks';
import type { ToolRowContent } from '../../lib/chat-types';

/**
 * The three rich renderers a work-card row can need — a diff, a terminal block,
 * and the raw I/O disclosure — plus the caps that keep one runaway tool result
 * from freezing the tab.
 *
 * Everything here is presentational and cap-first: a multi-megabyte `rawOutput`
 * is a plausible thing for an agent to hand us, so nothing renders unbounded.
 */

/** Rendered diff lines before the expand control kicks in. */
const DIFF_LINE_CAP = 400;
/** Rendered terminal lines before the expand control kicks in. */
const TERMINAL_LINE_CAP = 200;

function ExpandToggle({
  expanded,
  hidden,
  onToggle,
}: {
  expanded: boolean;
  hidden: number;
  onToggle: () => void;
}) {
  if (hidden <= 0 && !expanded) return null;
  return (
    <button
      type="button"
      onClick={onToggle}
      className="w-full border-t border-border/60 bg-muted/40 px-3 py-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
    >
      {expanded ? 'Show less' : `Show ${hidden} more line${hidden === 1 ? '' : 's'}`}
    </button>
  );
}

/** Unified line diff, computed client-side from the block's oldText/newText. */
export function DiffView({
  path,
  oldText,
  newText,
}: {
  path: string;
  oldText: string | null;
  newText: string;
}) {
  const lines = useMemo(() => toDiffLines(oldText, newText), [oldText, newText]);
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? lines : lines.slice(0, DIFF_LINE_CAP);

  return (
    <div className="overflow-hidden rounded-md border border-border/60">
      <div className="border-b border-border/60 bg-muted/40 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
        {path}
      </div>
      <div className="overflow-x-auto">
        <pre className="min-w-full font-mono text-[11px] leading-5">
          {shown.map((line, index) => (
            <div
              key={index}
              className={cn(
                'whitespace-pre px-3',
                line.kind === 'add' && 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
                line.kind === 'del' && 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
                line.kind === 'ctx' && 'text-muted-foreground',
              )}
            >
              <span className="select-none opacity-60">
                {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}
              </span>{' '}
              {line.text}
            </div>
          ))}
        </pre>
      </div>
      <ExpandToggle
        expanded={expanded}
        hidden={lines.length - shown.length}
        onToggle={() => setExpanded((v) => !v)}
      />
    </div>
  );
}

/** Monospace command output, ANSI-stripped and capped. */
export function TerminalBlock({ text }: { text: string }) {
  const lines = useMemo(() => stripAnsi(text).replace(/\n$/, '').split('\n'), [text]);
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? lines : lines.slice(0, TERMINAL_LINE_CAP);

  return (
    <div className="overflow-hidden rounded-md border border-border/60 bg-muted/30">
      <div className="overflow-x-auto">
        <pre className="whitespace-pre px-3 py-2 font-mono text-[11px] leading-5 text-foreground">
          {shown.join('\n')}
        </pre>
      </div>
      <ExpandToggle
        expanded={expanded}
        hidden={lines.length - shown.length}
        onToggle={() => setExpanded((v) => !v)}
      />
    </div>
  );
}

/** The unclassified remainder, behind a `<details>` so it never fills the tab. */
export function RawIoDisclosure({ rawInput, rawOutput }: { rawInput?: unknown; rawOutput?: unknown }) {
  if (rawInput === undefined && rawOutput === undefined) return null;
  const sections: Array<[string, string]> = [];
  if (rawInput !== undefined) sections.push(['Input', prettyJson(rawInput)]);
  if (rawOutput !== undefined) sections.push(['Output', prettyJson(rawOutput)]);

  return (
    <details className="rounded-md border border-border/60 bg-muted/20">
      <summary className="cursor-pointer px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground">
        Raw input / output
      </summary>
      <div className="space-y-2 px-3 pb-3">
        {sections.map(([label, body]) => (
          <div key={label}>
            <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
            <div className="overflow-x-auto">
              <pre className="whitespace-pre font-mono text-[11px] leading-5">{capRawIo(body)}</pre>
            </div>
          </div>
        ))}
      </div>
    </details>
  );
}

/** Render one tool-row content block by its kind. */
export function ToolContentBlock({ block }: { block: ToolRowContent }) {
  switch (block.type) {
    case 'diff':
      return <DiffView path={block.path} oldText={block.oldText} newText={block.newText} />;
    case 'terminal':
      // Decision 6: no client terminal capability, so there is no live output to
      // attach — only the id the agent used.
      return (
        <div className="rounded-md border border-dashed border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
          terminal {block.terminalId} (output not streamed)
        </div>
      );
    default:
      return <TerminalBlock text={block.text} />;
  }
}
