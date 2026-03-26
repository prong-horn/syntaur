interface CommandSnippetProps {
  command: string;
  description?: string;
  example?: string;
}

export function CommandSnippet({
  command,
  description,
  example,
}: CommandSnippetProps) {
  return (
    <div className="rounded-lg border border-border/70 bg-slate-950 px-3 py-3 text-slate-100 shadow-sm">
      <code className="block overflow-x-auto font-mono text-sm">{command}</code>
      {description ? <p className="mt-2 text-sm text-slate-300">{description}</p> : null}
      {example ? <p className="mt-2 font-mono text-xs text-slate-400">{example}</p> : null}
    </div>
  );
}
