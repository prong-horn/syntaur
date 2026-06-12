import { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, AlertCircle } from 'lucide-react';
import { SectionCard } from '../components/SectionCard';
import { useStatusConfig, invalidateStatusConfigCache } from '../hooks/useStatusConfig';
import type { RawFactDeclaration } from '@shared/fact-registry';
import {
  validateFactsForSave,
  buildFactsSavePayload,
  flagInvalidRows,
} from './facts-section-helpers';
import { FactDeleteModal } from './FactDeleteModal';

interface Feedback {
  type: 'success' | 'error';
  message: string;
}

interface FactReference {
  factName: string;
  location: string;
  when: string;
}

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

export function FactsSection() {
  const config = useStatusConfig();
  const [rows, setRows] = useState<RawFactDeclaration[]>(config.rawFacts);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalReferences, setModalReferences] = useState<FactReference[]>([]);
  const [pendingAcks, setPendingAcks] = useState<string[]>([]);

  useEffect(() => {
    setRows(config.rawFacts);
    setDirty(false);
    setFeedback(null);
    setPendingAcks([]);
  }, [config.rawFacts]);

  const problems = validateFactsForSave(rows);
  const invalidMap = flagInvalidRows(rows);

  function flash(next: Feedback) {
    setFeedback(next);
    setTimeout(() => setFeedback(null), 3500);
  }

  const addRow = useCallback(() => {
    setRows((prev) => [...prev, emptyRow()]);
    setDirty(true);
    setFeedback(null);
  }, []);

  const updateRow = useCallback((index: number, field: keyof RawFactDeclaration, value: string | null) => {
    setRows((prev) => {
      const next = prev.map((r, i) => (i === index ? { ...r, [field]: value } : r));
      return next;
    });
    setDirty(true);
    setFeedback(null);
  }, []);

  const removeRow = useCallback((index: number) => {
    setRows((prev) => prev.filter((_, i) => i !== index));
    setDirty(true);
    setFeedback(null);
  }, []);

  async function performSave(acks: string[]) {
    const payload = buildFactsSavePayload(rows, acks.length > 0 ? acks : undefined);
    const res = await fetch('/api/config/statuses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (res.status === 409) {
      const body = (await res.json()) as { error: string; references?: FactReference[] };
      if (body.error === 'unresolved-fact-references' && body.references) {
        setModalReferences(body.references);
        setModalOpen(true);
        return 'modal' as const;
      }
      throw new Error(body.error ?? 'Save rejected');
    }

    if (res.status === 400) {
      const body = (await res.json()) as { error: string; problems?: string[]; message?: string };
      if (body.problems) {
        throw new Error(body.problems.join('; '));
      }
      throw new Error(body.message ?? body.error ?? 'Invalid request');
    }

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    return 'success' as const;
  }

  async function handleSave() {
    if (saving) return;
    setSaving(true);
    setFeedback(null);
    try {
      const result = await performSave(pendingAcks);
      if (result === 'modal') {
        setSaving(false);
        return;
      }
      invalidateStatusConfigCache();
      const fresh = await fetch('/api/config/statuses').then((r) => r.json());
      setRows(fresh.rawFacts ?? []);
      setDirty(false);
      setPendingAcks([]);
      flash({ type: 'success', message: 'Facts saved.' });
    } catch (err) {
      flash({
        type: 'error',
        message: err instanceof Error ? err.message : 'Save failed.',
      });
    } finally {
      setSaving(false);
    }
  }

  function handleModalConfirm() {
    const acks = Array.from(new Set([...pendingAcks, ...modalReferences.map((r) => r.factName)]));
    setPendingAcks(acks);
    setModalOpen(false);
    // Re-save with acks.
    setSaving(true);
    performSave(acks)
      .then(async (result) => {
        if (result === 'modal') return;
        invalidateStatusConfigCache();
        const fresh = await fetch('/api/config/statuses').then((r) => r.json());
        setRows(fresh.rawFacts ?? []);
        setDirty(false);
        setPendingAcks([]);
        flash({ type: 'success', message: 'Facts saved.' });
      })
      .catch((err) => {
        flash({
          type: 'error',
          message: err instanceof Error ? err.message : 'Save failed.',
        });
      })
      .finally(() => {
        setSaving(false);
      });
  }

  const canSave = dirty && !saving && problems.length === 0;

  return (
    <>
      <SectionCard
        title="Facts"
        description="Declare custom facts and attestation fields for derive rules and the fact vocabulary."
        actions={
          <button
            className="shell-action bg-primary/10 text-primary hover:bg-primary/20 disabled:opacity-50"
            onClick={handleSave}
            disabled={!canSave}
            type="button"
          >
            {saving ? 'Saving...' : 'Save Facts'}
          </button>
        }
      >
        {feedback && (
          <div
            className={`mb-3 rounded-md border px-3 py-1.5 text-xs ${
              feedback.type === 'success'
                ? 'border-success-foreground/30 bg-success text-success-foreground'
                : 'border-error-foreground/30 bg-error text-error-foreground'
            }`}
          >
            {feedback.message}
          </div>
        )}

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
                className={`flex items-start gap-2 rounded-md border p-2 ${
                  invalid
                    ? 'border-error-foreground/40 bg-error/5'
                    : 'border-border/60 bg-background/80'
                }`}
              >
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
                      updateRow(i, 'type', type);
                      if (type !== 'attestation') {
                        updateRow(i, 'binds', null);
                      }
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
                <button
                  type="button"
                  onClick={() => removeRow(i)}
                  disabled={saving}
                  className="mt-0.5 shell-action text-xs text-muted-foreground hover:text-error disabled:opacity-50"
                  title="Delete"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
                {invalid && (
                  <div className="flex items-center gap-1 text-xs text-error-foreground" title={invalid}>
                    <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
                  </div>
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

      <FactDeleteModal
        open={modalOpen}
        references={modalReferences}
        onConfirm={handleModalConfirm}
        onCancel={() => {
          setModalOpen(false);
          setSaving(false);
        }}
      />
    </>
  );
}
