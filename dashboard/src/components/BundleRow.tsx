import type { BundleWithMembers } from '../types';

const STATUS_LABEL: Record<BundleWithMembers['derivedStatus']['status'], { icon: string; cls: string; label: string }> = {
  open: { icon: '○', cls: 'text-muted-foreground', label: 'Open' },
  in_progress: { icon: '◉', cls: 'text-status-in-progress-foreground', label: 'In progress' },
  blocked: { icon: '✕', cls: 'text-status-blocked-foreground', label: 'Blocked' },
  completed: { icon: '✓', cls: 'text-status-completed-foreground', label: 'Completed' },
  mixed: { icon: '◐', cls: 'text-muted-foreground', label: 'Mixed' },
};

interface BundleRowProps {
  bundle: BundleWithMembers;
}

export function BundleRow({ bundle }: BundleRowProps) {
  const status = STATUS_LABEL[bundle.derivedStatus.status];
  const { counts } = bundle.derivedStatus;
  return (
    <div className="border rounded-md p-3 mb-2 bg-card">
      <div className="flex items-center gap-3">
        <span className={`text-lg leading-none ${status.cls}`} title={status.label}>{status.icon}</span>
        <span className="font-mono text-sm text-muted-foreground">b:{bundle.id}</span>
        {bundle.slug && <span className="font-medium">{bundle.slug}</span>}
        <span className="ml-auto text-sm text-muted-foreground">
          {counts.completed}/{counts.total} done
        </span>
      </div>
      <div className="mt-2 grid gap-1 text-sm">
        {bundle.branch && (
          <div className="text-muted-foreground">
            <span className="font-medium">Branch:</span> <code className="font-mono">{bundle.branch}</code>
          </div>
        )}
        {bundle.worktreePath && (
          <div className="text-muted-foreground truncate">
            <span className="font-medium">Worktree:</span> <code className="font-mono">{bundle.worktreePath}</code>
          </div>
        )}
        {bundle.planDir && (
          <div className="text-muted-foreground truncate">
            <span className="font-medium">Plan:</span> <code className="font-mono">{bundle.planDir}</code>
          </div>
        )}
      </div>
      <ul className="mt-2 ml-6 text-sm list-disc">
        {bundle.members.map((m) => (
          <li key={m.id} className={m.status === 'completed' ? 'line-through text-muted-foreground' : ''}>
            <span className="font-mono text-xs text-muted-foreground mr-2">t:{m.id}</span>
            {m.description}
          </li>
        ))}
      </ul>
    </div>
  );
}

interface BundleSectionProps {
  bundles: BundleWithMembers[];
  title?: string;
}

export function BundleSection({ bundles, title = 'Bundles' }: BundleSectionProps) {
  if (bundles.length === 0) return null;
  return (
    <section className="mb-6">
      <h3 className="text-sm font-medium text-muted-foreground mb-2">
        {title} ({bundles.length})
      </h3>
      {bundles.map((b) => (
        <BundleRow key={b.id} bundle={b} />
      ))}
    </section>
  );
}
