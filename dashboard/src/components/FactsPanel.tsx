import { SectionCard } from './SectionCard';
import { cn } from '../lib/utils';

interface Attestation {
  fact: string;
  binds: 'plan' | 'commit' | 'none';
  records: Array<{
    actor: string;
    verdict: 'approved' | 'changes-requested';
    at: string;
    note: string | null;
    stale: boolean;
  }>;
}

interface FactsPanelProps {
  customFacts?: Record<string, boolean | number>;
  attestations?: Attestation[];
}

/**
 * Current materialized state of an assignment's custom facts and review
 * attestations (server-derived; display-only). Renders nothing when there are
 * no facts or attestations — i.e. for zero-config users and terminal
 * assignments (derived: null). Lives inside the Activity tab, above the
 * audit-trail timeline, so the "now" state sits next to the history of changes.
 */
export function FactsPanel({ customFacts, attestations }: FactsPanelProps) {
  const facts = customFacts ?? {};
  const atts = attestations ?? [];
  if (Object.keys(facts).length === 0 && atts.length === 0) return null;

  return (
    <SectionCard
      title="Facts"
      description="Custom asserted facts and review attestations, materialized server-side."
    >
      <div className="space-y-3">
        {Object.keys(facts).length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            {Object.entries(facts).map(([name, value]) => (
              <span
                key={name}
                className="rounded-full border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground"
              >
                {name}: <span className="font-medium text-foreground">{String(value)}</span>
              </span>
            ))}
          </div>
        )}
        {atts.map((att) => (
          <div key={att.fact} className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-medium text-foreground">{att.fact}</span>
            <span className="text-[11px] text-muted-foreground">({att.binds})</span>
            {att.records.length === 0 ? (
              <span className="text-[11px] text-muted-foreground">— no attestations yet</span>
            ) : (
              att.records.map((r) => (
                <span
                  key={r.actor}
                  title={`${r.verdict}${r.note ? ` — ${r.note}` : ''}${
                    r.stale ? ' (stale — revision moved)' : ''
                  } · ${r.at}`}
                  className={cn(
                    'rounded-full border px-2 py-0.5 text-[11px]',
                    r.stale
                      ? 'border-border/40 text-muted-foreground line-through'
                      : r.verdict === 'approved'
                        ? 'border-success-foreground/40 text-success-foreground'
                        : 'border-warning-foreground/40 text-warning-foreground',
                  )}
                >
                  {r.actor}: {r.verdict === 'approved' ? 'approved' : 'changes'}
                  {r.stale ? ' (stale)' : ''}
                </span>
              ))
            )}
          </div>
        ))}
      </div>
    </SectionCard>
  );
}
