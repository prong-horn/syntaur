import { useEffect, useState } from 'react';
import { Boxes, Clock, ShieldAlert } from 'lucide-react';
import { useInventories } from '../hooks/useProjects';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useToast, Toaster } from '../components/Toast';
import type {
  InventoryDetail,
  InventoryMember,
  Lease,
  MemberStatus,
} from '../types';

function formatTtl(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

function formatCountdown(expiresAt: string, now: number): string {
  const exp = Date.parse(expiresAt);
  const diff = Math.floor((exp - now) / 1000);
  if (Number.isNaN(diff)) return '–';
  if (diff <= 0) return 'expired';
  return formatTtl(diff);
}

function memberStatusClass(status: MemberStatus): string {
  switch (status) {
    case 'idle':
      return 'border-success-foreground/30 bg-success text-success-foreground';
    case 'leased':
      return 'border-warning-foreground/30 bg-warning text-warning-foreground';
    case 'retired':
      return 'border-muted-foreground/30 bg-muted text-muted-foreground';
  }
}

function parseMetadata(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function InventoriesPage() {
  const { data, loading, error, refetch } = useInventories();
  const [now, setNow] = useState(() => Date.now());
  const [forceReleaseTarget, setForceReleaseTarget] = useState<
    { slug: string; lease: Lease } | null
  >(null);
  const [forceReleasing, setForceReleasing] = useState(false);
  const { toast, showToast, dismissToast } = useToast();

  // Tick once per second so countdowns update.
  useEffect(() => {
    const handle = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(handle);
  }, []);

  if (loading) {
    return <LoadingState label="Loading inventories…" />;
  }
  if (error) {
    return (
      <ErrorState
        title="Could not load inventories"
        error={error}
        action={
          <button
            type="button"
            onClick={refetch}
            className="rounded border px-3 py-1 text-sm"
          >
            Retry
          </button>
        }
      />
    );
  }
  if (!data || data.inventories.length === 0) {
    return (
      <EmptyState
        title="No inventories yet"
        description="Create one with `syntaur lease create-inventory <slug> --kind <kind>`, then add members with `syntaur lease member add <slug> <id>`."
      />
    );
  }

  async function handleForceRelease(): Promise<void> {
    if (!forceReleaseTarget) return;
    setForceReleasing(true);
    try {
      const response = await fetch(
        `/api/leases/${encodeURIComponent(
          forceReleaseTarget.slug,
        )}/force-release/${encodeURIComponent(forceReleaseTarget.lease.lease_id)}`,
        { method: 'POST' },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(body?.error ?? `HTTP ${response.status}`);
      }
      refetch();
      setForceReleaseTarget(null);
    } catch (err) {
      showToast(
        err instanceof Error
          ? `Force release failed: ${err.message}`
          : 'Force release failed',
        'error',
      );
    } finally {
      setForceReleasing(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Inventories</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Claimable shared resources (dev envs, test DBs, named locks, …).
            Global in v1 — the same set appears on every workspace.
          </p>
        </div>
      </div>

      <div className="grid gap-4">
        {data.inventories.map((detail) => (
          <InventoryCard
            key={detail.inventory.slug}
            detail={detail}
            now={now}
            onForceRelease={(lease) =>
              setForceReleaseTarget({ slug: detail.inventory.slug, lease })
            }
          />
        ))}
      </div>

      <ConfirmDialog
        open={forceReleaseTarget !== null}
        title="Force release this lease?"
        description={
          forceReleaseTarget
            ? `This will revoke lease ${forceReleaseTarget.lease.lease_id} and (if it's still the current holder) free member ${forceReleaseTarget.lease.member_id}. Any agent still using this lease will see a stale-lease error on its next CLI call.`
            : ''
        }
        confirmLabel="Force release"
        destructive
        loading={forceReleasing}
        onConfirm={handleForceRelease}
        onOpenChange={(open) => {
          if (!open) setForceReleaseTarget(null);
        }}
      />
      <Toaster toast={toast} onDismiss={dismissToast} />
    </div>
  );
}

function InventoryCard({
  detail,
  now,
  onForceRelease,
}: {
  detail: InventoryDetail;
  now: number;
  onForceRelease: (lease: Lease) => void;
}) {
  const { inventory, members, active_leases } = detail;
  const idleCount = members.filter((m) => m.status === 'idle').length;
  const leasedCount = members.filter((m) => m.status === 'leased').length;
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold">
            <Boxes className="mr-2 inline h-4 w-4 text-muted-foreground" />
            {inventory.display_name ?? inventory.slug}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            <code className="font-mono">{inventory.slug}</code> · kind=
            {inventory.kind} · default TTL={formatTtl(inventory.default_ttl_s)}
          </p>
        </div>
        <div className="text-right text-xs text-muted-foreground">
          <div>
            {idleCount} idle · {leasedCount} leased · {members.length} total
          </div>
        </div>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {members.map((member) => (
          <MemberPill key={member.member_id} member={member} />
        ))}
      </div>

      {active_leases.length > 0 && (
        <div className="mt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Active leases
          </h3>
          <div className="mt-2 space-y-2">
            {active_leases.map((lease) => (
              <LeaseRow
                key={lease.lease_id}
                lease={lease}
                now={now}
                onForceRelease={() => onForceRelease(lease)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function MemberPill({ member }: { member: InventoryMember }) {
  const meta = parseMetadata(member.metadata_json);
  return (
    <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
      <div className="flex items-center justify-between">
        <span className="font-mono">{member.member_id}</span>
        <span
          className={`rounded border px-1.5 py-0.5 text-xs ${memberStatusClass(
            member.status,
          )}`}
        >
          {member.status}
        </span>
      </div>
      {meta && (
        <div className="mt-1 text-xs text-muted-foreground">
          {Object.entries(meta).map(([k, v]) => (
            <div key={k} className="truncate">
              <span className="font-mono">{k}</span>=
              <span className="font-mono">{String(v)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function LeaseRow({
  lease,
  now,
  onForceRelease,
}: {
  lease: Lease;
  now: number;
  onForceRelease: () => void;
}) {
  return (
    <div className="flex items-center justify-between rounded border bg-muted/20 px-3 py-2 text-sm">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-muted-foreground">
            {lease.lease_id.slice(0, 8)}…
          </span>
          <span className="font-mono">{lease.member_id}</span>
          {lease.requested_for && (
            <span className="text-xs text-muted-foreground">
              for {lease.requested_for}
            </span>
          )}
        </div>
      </div>
      <div className="ml-3 flex items-center gap-3">
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <Clock className="h-3 w-3" />
          {formatCountdown(lease.expires_at, now)}
        </span>
        <button
          type="button"
          onClick={onForceRelease}
          className="flex items-center gap-1 rounded border border-destructive/40 px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
        >
          <ShieldAlert className="h-3 w-3" />
          Force release
        </button>
      </div>
    </div>
  );
}
