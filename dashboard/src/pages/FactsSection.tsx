import { useCallback } from 'react';
import { Plus, Trash2, AlertCircle } from 'lucide-react';
import { SectionCard } from '../components/SectionCard';
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip';
import type { RawFactDeclaration } from '@shared/fact-registry';
import { flagInvalidRows } from './facts-section-helpers';

const KIND_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'bool', label: 'bool' },
  { value: 'number', label: 'number' },
  { value: 'attestation', label: 'attestation' },
];

const BINDS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'plan', label: 'plan' },
  { value: 'commit', label: 'commit' },
  { value: 'none', label: 'none' },
];

function emptyRow(): RawFactDeclaration {
  return { name: '', type: 'bool', binds: null };
}

interface FactsSectionProps {
  rows: RawFactDeclaration[];
  onChange: (rows: RawFactDeclaration[]) => void;
  saving?: boolean;
}

/**
 * Controlled facts editor. State (rows) is lifted into SettingsPage so the
 * unified Save Configuration button persists facts alongside statuses, derive,
 * and transitions; this component is purely presentational.
 */
export function FactsSection({ rows, onChange, saving }: FactsSectionProps) {
  const invalidMap = flagInvalidRows(rows);

  const addRow = useCallback(() => {
    onChange([...rows, emptyRow()]);
  }, [rows, onChange]);

  const updateRow = useCallback(
    (index: number, field: keyof RawFactDeclaration, value: string | null) => {
      onChange(rows.map((r, i) => (i === index ? { ...r, [field]: value } : r)));
    },
    [rows, onChange],
  );

  const removeRow = useCallback(
    (index: number) => {
      onChange(rows.filter((_, i) => i !== index));
    },
    [rows, onChange],
  );

  return (
    <SectionCard
      title="Facts"
      description="Declare custom facts and attestation fields for derive rules and the fact vocabulary."
    >
      <p className="mb-3 text-xs text-muted-foreground">
        Names must match <code className="font-mono">^[a-z][a-zA-Z0-9]*</code> — start with a lowercase
        letter, then letters or numbers only (no spaces, hyphens, or underscores).
      </p>

      <div className="space-y-2">
        {rows.length === 0 && (
          <p className="text-sm text-muted-foreground italic">No custom facts declared.</p>
        )}

        {rows.map((row, i) => {
          const invalid = invalidMap.get(i);
          const isAttestation = row.type === 'attestation';
          return (
            <div
              key={i}
              className={`rounded-md border p-2 ${
                invalid ? 'border-error-foreground/40 bg-error/5' : 'border-border/60 bg-background/80'
              }`}
            >
              <div className="flex items-start gap-2">
                <div className="flex-1 grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <input
                    type="text"
                    value={row.name}
                    onChange={(e) => updateRow(i, 'name', e.target.value)}
                    placeholder="factName"
                    disabled={saving}
                    className="w-full rounded-md border border-border/60 bg-background px-2 py-1 text-sm font-mono focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60"
                  />
                  <select
                    value={row.type}
                    onChange={(e) => {
                      const type = e.target.value;
                      // Update type and clear binds for non-attestation in one change
                      // so we never emit a transient half-updated row.
                      onChange(
                        rows.map((r, idx) =>
                          idx === i
                            ? { ...r, type, binds: type === 'attestation' ? r.binds : null }
                            : r,
                        ),
                      );
                    }}
                    disabled={saving}
                    className="w-full rounded-md border border-border/60 bg-background px-2 py-1 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60"
                  >
                    {KIND_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  {isAttestation ? (
                    <select
                      value={row.binds ?? 'none'}
                      onChange={(e) => updateRow(i, 'binds', e.target.value)}
                      disabled={saving}
                      className="w-full rounded-md border border-border/60 bg-background px-2 py-1 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60"
                    >
                      {BINDS_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="text-sm text-muted-foreground py-1">—</span>
                  )}
                </div>
                {invalid && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="mt-1 inline-flex text-error-foreground" aria-label="Invalid fact">
                        <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs text-xs font-normal normal-case tracking-normal">
                      {invalid}
                    </TooltipContent>
                  </Tooltip>
                )}
                <button
                  type="button"
                  onClick={() => removeRow(i)}
                  disabled={saving}
                  className="mt-0.5 shell-action text-xs text-muted-foreground hover:text-error disabled:opacity-50"
                  title="Delete"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              {invalid && (
                <p className="mt-1 text-xs text-error-foreground">{invalid}</p>
              )}
            </div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={addRow}
        disabled={saving}
        className="mt-2 shell-action text-xs inline-flex items-center gap-1 disabled:opacity-50"
      >
        <Plus className="h-3.5 w-3.5" />
        Add fact
      </button>
    </SectionCard>
  );
}
