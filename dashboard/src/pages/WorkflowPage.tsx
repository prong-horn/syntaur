import { useState, useEffect, useCallback, useMemo } from 'react';
import { RotateCcw, Save, Info } from 'lucide-react';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { TooltipProvider } from '../components/ui/tooltip';
import { ContentTabs } from '../components/ContentTabs';
import type {
  StatusConfigResponse,
  StatusResolution,
  AffectedResponse,
  StatusConfigSaveResponse,
} from '../hooks/useStatusConfig';
import { invalidateStatusConfigCache } from '../hooks/useStatusConfig';
import { StatusDeleteModal } from './StatusDeleteModal';
import { FactDeleteModal } from './FactDeleteModal';
import { StatusDefinitionsSection } from './StatusDefinitionsSection';
import {
  buildStatusSavePayload,
  pruneStaleResolutions,
  findStatusRuleReferences,
  headlineReferencesStatus,
  remapStatusInDerive,
  remapStatusInTransitions,
  dropStatusFromDerive,
  dropStatusFromTransitions,
  type StatusRuleReference,
} from './settings-page-helpers';
import { type EditableStatus, makeRowKey, toEditable } from './status-section-helpers';
import { FactsSection } from './FactsSection';
import { DeriveRulesSection } from './DeriveRulesSection';
import { TransitionsSection } from './TransitionsSection';
import {
  toEditableDerive,
  fromEditableDerive,
  validateDeriveSection,
  type EditableDerive,
} from './derive-rules-helpers';
import {
  toEditableTransitions,
  fromEditableTransitions,
  defaultTransitions,
  filterValidTransitions,
  validateTransitions,
  type EditableTransition,
} from './transitions-helpers';
import { acceptedFactsFromRows } from '../components/condition-editor-helpers';
import { validateFactsForSave } from './facts-section-helpers';
import { buildDeriveRegistry } from '@shared/fact-registry';
import { DEFAULT_DERIVE_CONFIG } from '@shared/derive-config';
import type { RawFactDeclaration } from '@shared/fact-registry';
import { tabProblemSummary } from './workflow-page-helpers';

export function WorkflowPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [custom, setCustom] = useState(false);
  const [statuses, setStatuses] = useState<EditableStatus[]>([]);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [dirty, setDirty] = useState(false);

  // Orphan-prompt state. `savedStatusIds` tracks which ids are backed by
  // disk (so we know when the trash-icon click is a delete-of-saved-status
  // that may have orphans). `pendingResolutions` buffers user choices
  // between the trash click and Save. `modalState` controls the modal.
  const [savedStatusIds, setSavedStatusIds] = useState<Set<string>>(new Set());
  const [pendingResolutions, setPendingResolutions] = useState<Map<string, StatusResolution>>(
    new Map(),
  );
  const [modalState, setModalState] = useState<
    | { open: true; affected: AffectedResponse; pendingId: string; ruleReferences: StatusRuleReference[]; headlineReferences: boolean }
    | { open: false }
  >({ open: false });

  // ── Facts (lifted out of FactsSection for the unified save) ──────────────
  const [factRows, setFactRows] = useState<RawFactDeclaration[]>([]);
  const [pendingFactAcks, setPendingFactAcks] = useState<string[]>([]);
  const [factModal, setFactModal] = useState<
    | { open: true; references: Array<{ factName: string; location: string; when: string }> }
    | { open: false }
  >({ open: false });

  // ── Derive rules ─────────────────────────────────────────────────────────
  // `derive` is the editable model (with row keys); `deriveCustom` mirrors the
  // server flag and flips true on any edit. `deriveDirty`/`deriveReset` drive
  // presence semantics in the payload: untouched defaults → omit (preserve);
  // edited → send the object; reset → send null.
  const [derive, setDerive] = useState<EditableDerive>(() => toEditableDerive(DEFAULT_DERIVE_CONFIG));
  const [deriveCustom, setDeriveCustom] = useState(false);
  const [deriveDirty, setDeriveDirty] = useState(false);
  const [deriveReset, setDeriveReset] = useState(false);

  // ── Transitions ──────────────────────────────────────────────────────────
  const [transitions, setTransitions] = useState<EditableTransition[]>([]);
  const [transitionsCustomizing, setTransitionsCustomizing] = useState(false);
  const [knownCommands, setKnownCommands] = useState<string[]>([]);

  // Active tab for the four-tab layout.
  const [activeTab, setActiveTab] = useState('statuses');

  // Hydrate every editable section from a config response. Used on initial
  // load, after a successful save (the POST returns the full GET shape), and
  // after a reset — so all sections stay coherent and `dirty` clears together.
  const hydrateSections = useCallback((data: StatusConfigResponse) => {
    const editable = toEditable(data);
    setStatuses(editable);
    setCustom(data.custom);
    setSavedStatusIds(new Set(editable.map((s) => s.id)));
    setPendingResolutions(new Map());
    setFactRows(data.rawFacts ?? []);
    setPendingFactAcks([]);
    setDerive(toEditableDerive(data.derive ?? DEFAULT_DERIVE_CONFIG));
    setDeriveCustom(data.deriveCustom ?? false);
    setDeriveDirty(false);
    setDeriveReset(false);
    setTransitions(toEditableTransitions(data.transitions ?? []));
    setTransitionsCustomizing(data.transitionsCustom ?? false);
    setKnownCommands(data.knownCommands ?? []);
    setDirty(false);
  }, []);

  const loadConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/config/statuses');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: StatusConfigResponse = await res.json();
      hydrateSections(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load config');
    } finally {
      setLoading(false);
    }
  }, [hydrateSections]);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  function clearFeedback() {
    setTimeout(() => setFeedback(null), 3000);
  }

  // ── Derived: shared section inputs + cross-section validation ─────────────
  const statusOptions = useMemo(() => statuses.map((s) => ({ id: s.id, label: s.label })), [statuses]);
  const statusIds = useMemo(() => new Set(statuses.map((s) => s.id)), [statuses]);
  const acceptedFacts = useMemo(() => acceptedFactsFromRows(factRows), [factRows]);
  const deriveRegistry = useMemo(() => buildDeriveRegistry(acceptedFacts), [acceptedFacts]);

  const factProblems = useMemo(() => validateFactsForSave(factRows), [factRows]);
  const deriveProblems = useMemo(() => {
    try {
      return validateDeriveSection(fromEditableDerive(derive), statuses, deriveRegistry);
    } catch {
      return ['derive rules are malformed'];
    }
  }, [derive, statuses, deriveRegistry]);
  const transitionProblems = useMemo(
    () => (transitionsCustomizing ? validateTransitions(transitions, statusIds) : []),
    [transitions, transitionsCustomizing, statusIds],
  );
  const sectionProblems = factProblems.length + deriveProblems.length + transitionProblems.length;

  // ── Section change handlers (each marks the unified dirty flag) ───────────
  const onFactsChange = useCallback((rows: RawFactDeclaration[]) => {
    setFactRows(rows);
    setDirty(true);
  }, []);
  const onDeriveChange = useCallback((next: EditableDerive) => {
    setDerive(next);
    setDeriveDirty(true);
    setDeriveReset(false);
    setDeriveCustom(true);
    setDirty(true);
  }, []);
  const onDeriveReset = useCallback(() => {
    setDerive(toEditableDerive(DEFAULT_DERIVE_CONFIG));
    setDeriveReset(true);
    setDeriveDirty(true);
    setDeriveCustom(false);
    setDirty(true);
  }, []);
  const onTransitionsChange = useCallback((next: EditableTransition[]) => {
    setTransitions(next);
    setDirty(true);
  }, []);
  const onTransitionsCustomize = useCallback(() => {
    setTransitions((prev) =>
      prev.length > 0 ? prev : toEditableTransitions(filterValidTransitions(defaultTransitions(), statusIds)),
    );
    setTransitionsCustomizing(true);
    setDirty(true);
  }, [statusIds]);

  async function handleSave(acks: string[] = pendingFactAcks) {
    setSaving(true);
    setFeedback(null);
    try {
      const { body } = buildStatusSavePayload({
        statuses,
        order: statuses.map((s) => s.id),
        pendingResolutions,
        facts: factRows,
        factRemovalAcks: acks,
        derive: deriveReset ? null : deriveDirty ? fromEditableDerive(derive) : undefined,
        transitions: transitionsCustomizing ? fromEditableTransitions(transitions) : undefined,
      });
      const res = await fetch('/api/config/statuses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        if (res.status === 409 && errBody?.error === 'unresolved-fact-references' && errBody.references) {
          setFactModal({ open: true, references: errBody.references });
          setSaving(false);
          return;
        }
        if (errBody?.error === 'invalid-derive') {
          throw new Error(`Invalid derive rules: ${(errBody.problems ?? []).join('; ')}`);
        }
        if (errBody?.error === 'invalid-transitions') {
          throw new Error(`Invalid transitions: ${(errBody.problems ?? []).join('; ')}`);
        }
        if (errBody?.error === 'invalid-facts') {
          throw new Error(`Invalid facts: ${(errBody.problems ?? []).join('; ')}`);
        }
        if (res.status === 409 && errBody?.error === 'unresolved-orphans') {
          const ids = Array.isArray(errBody.unresolved)
            ? errBody.unresolved.map((u: { id: string }) => u.id).join(', ')
            : '';
          throw new Error(
            `Cannot save — these statuses have assignments that need a resolution: ${ids}. Click the trash icon on each row to choose remap or delete.`,
          );
        }
        if (res.status === 409 && errBody?.error === 'concurrent-edit') {
          const applied = errBody.applied
            ? ` (${errBody.applied.remapped} remapped, ${errBody.applied.deleted} deleted before the conflict)`
            : '';
          setFeedback({
            type: 'error',
            message: `Concurrent edit detected${applied}: ${errBody.cause ?? 'an assignment moved to a still-dropped status during save'}. Refreshing — please re-resolve.`,
          });
          await loadConfig();
          return;
        }
        if (res.status === 500 && errBody?.error === 'config-write-failed' && errBody?.applied) {
          const { remapped, deleted } = errBody.applied;
          const cause = errBody.message ? `: ${errBody.message}` : '';
          setFeedback({
            type: 'error',
            message: `Resolutions applied (${remapped} remapped, ${deleted} deleted) but the status config write failed${cause}. Click Save again to retry.`,
          });
          await loadConfig();
          return;
        }
        if (errBody?.error === 'invalid-remap-target') {
          throw new Error(
            `Invalid remap target (${errBody.reason}): ${errBody.id} → ${errBody.target}.`,
          );
        }
        if (errBody?.error === 'duplicate-resolution-ids') {
          throw new Error(`Duplicate resolution ids: ${(errBody.ids ?? []).join(', ')}`);
        }
        if (errBody?.error === 'stale-resolution') {
          throw new Error(`Stale resolution for id "${errBody.id ?? '?'}".`);
        }
        if (errBody?.error === 'malformed-resolutions') {
          throw new Error(`Malformed resolutions: ${errBody.message ?? 'unknown'}`);
        }
        if (errBody?.error === 'remap-write-failed' || errBody?.error === 'delete-failed' || errBody?.error === 'scan-failed') {
          throw new Error(`${errBody.error}: ${errBody.cause ?? 'unknown'}`);
        }
        throw new Error(errBody?.error ?? `Save failed (HTTP ${res.status})`);
      }
      const data: StatusConfigSaveResponse = await res.json();
      hydrateSections(data);
      invalidateStatusConfigCache();
      const appliedMsg = data.applied
        ? ` (${data.applied.remapped} remapped, ${data.applied.deleted} deleted)`
        : '';
      setFeedback({ type: 'success', message: `Status config saved${appliedMsg}` });
      clearFeedback();
    } catch (err) {
      setFeedback({ type: 'error', message: err instanceof Error ? err.message : 'Save failed' });
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    setSaving(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/config/statuses', { method: 'DELETE' });
      if (!res.ok) throw new Error('Reset failed');
      const data: StatusConfigResponse = await res.json();
      hydrateSections(data);
      invalidateStatusConfigCache();
      setFeedback({ type: 'success', message: 'Reset to defaults' });
      clearFeedback();
    } catch (err) {
      setFeedback({ type: 'error', message: err instanceof Error ? err.message : 'Reset failed' });
    } finally {
      setSaving(false);
    }
  }

  // --- Status definition mutations ---
  // Handlers are index-based: the rendered list maps directly over `statuses`,
  // so the row's array index is its position. `statuses` array order is also
  // the persisted display order (derived as statuses.map(s => s.id) on save).
  function updateStatus(index: number, field: keyof EditableStatus, value: string | boolean) {
    setStatuses((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
    setDirty(true);
  }

  function addStatus() {
    const newId = `status_${statuses.length + 1}`;
    setStatuses((prev) => [
      ...prev,
      { rowKey: makeRowKey(), id: newId, label: 'New Status', description: '', color: '', terminal: false },
    ]);
    setDirty(true);
  }

  function dropRowAndPrune(removedId: string) {
    setStatuses((prev) => {
      const nextStatuses = prev.filter((s) => s.id !== removedId);
      const nextIds = new Set(nextStatuses.map((s) => s.id));
      setPendingResolutions((prevRes) => pruneStaleResolutions(prevRes, nextIds));
      return nextStatuses;
    });
    setDirty(true);
  }

  async function removeStatus(index: number) {
    const removedId = statuses[index].id;
    const ruleReferences = findStatusRuleReferences(removedId, derive, transitions);
    const headlineReferences = headlineReferencesStatus(removedId, derive);

    // Row added in this session (not on disk yet) — no assignments possible.
    if (!savedStatusIds.has(removedId)) {
      if (ruleReferences.length === 0) {
        dropRowAndPrune(removedId);
        return;
      }
      setModalState({
        open: true,
        affected: { id: removedId, count: 0, truncated: false, assignments: [] },
        pendingId: removedId,
        ruleReferences,
        headlineReferences,
      });
      return;
    }

    // Row backed by disk — check for affected assignments.
    try {
      const res = await fetch(`/api/config/statuses/affected/${encodeURIComponent(removedId)}`);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const affected: AffectedResponse = await res.json();
      if (affected.count === 0 && ruleReferences.length === 0) {
        dropRowAndPrune(removedId);
        return;
      }
      setModalState({ open: true, affected, pendingId: removedId, ruleReferences, headlineReferences });
    } catch (err) {
      setFeedback({
        type: 'error',
        message: `Could not check affected assignments for "${removedId}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }
  }

  function handleModalResolve(resolution: StatusResolution, deriveRemapTarget: string) {
    if (!modalState.open) return;
    const { pendingId, affected, ruleReferences } = modalState;
    if (pendingId !== resolution.id) {
      setModalState({ open: false });
      return;
    }
    // Verify the row still exists in the current statuses array (it should,
    // unless the user did something weird like a rapid-fire double-click).
    if (!statuses.some((s) => s.id === pendingId)) {
      setFeedback({
        type: 'error',
        message: `Row for "${pendingId}" was already removed — modal action ignored.`,
      });
      setModalState({ open: false });
      return;
    }

    // Rewrite derive/transition references locally before the payload is built.
    if (resolution.mode === 'remap') {
      setDerive((d) => remapStatusInDerive(d, pendingId, deriveRemapTarget));
      setTransitions((t) => remapStatusInTransitions(t, pendingId, deriveRemapTarget));
    } else {
      // delete: drop ladder rungs + transitions; headline (if referenced)
      // remaps to the chosen target (headline cannot reference nothing).
      setDerive((d) => dropStatusFromDerive(d, pendingId, deriveRemapTarget));
      setTransitions((t) => dropStatusFromTransitions(t, pendingId));
    }
    if (ruleReferences.some((r) => r.section !== 'transitions')) {
      setDeriveDirty(true);
      setDeriveCustom(true);
    }

    setStatuses((prev) => {
      const nextStatuses = prev.filter((s) => s.id !== pendingId);
      const nextIds = new Set(nextStatuses.map((s) => s.id));
      setPendingResolutions((prevRes) => {
        // First drop resolutions whose target is now gone (because we just
        // removed pendingId), then add the new resolution for pendingId — but
        // only when there are real assignments to resolve (count 0 needs none).
        const pruned = pruneStaleResolutions(prevRes, nextIds);
        const next = new Map(pruned);
        if (affected.count > 0) next.set(pendingId, resolution);
        return next;
      });
      return nextStatuses;
    });
    setDirty(true);
    setModalState({ open: false });
  }

  function handleFactModalConfirm() {
    if (!factModal.open) return;
    const refs = factModal.references.map((r) => r.factName);
    const acks = Array.from(new Set([...pendingFactAcks, ...refs]));
    setPendingFactAcks(acks);
    setFactModal({ open: false });
    void handleSave(acks);
  }

  function handleModalCancel() {
    setModalState({ open: false });
  }

  if (loading) return <LoadingState label="Loading workflow..." />;
  if (error) return <ErrorState error={error} />;

  return (
    <TooltipProvider>
      <div className="space-y-6">
        {/* Config state banner */}
        <div className={`flex items-center justify-between rounded-lg border px-4 py-3 text-sm ${
          custom
            ? 'border-primary/30 bg-primary/5 text-primary'
            : 'border-border/60 bg-muted/30 text-muted-foreground'
        }`}>
          <div className="flex items-center gap-2">
            <Info className="h-4 w-4" />
            {custom
              ? 'Using custom status configuration from ~/.syntaur/config.md'
              : 'Using default status configuration'}
          </div>
          <button
            className="shell-action text-xs"
            onClick={handleReset}
            disabled={saving || (!custom && !dirty)}
          >
            <RotateCcw className="h-3 w-3" />
            Reset to Defaults
          </button>
        </div>

        {/* Feedback banner */}
        {feedback && (
          <div className={`rounded-lg border px-4 py-2 text-sm ${
            feedback.type === 'success'
              ? 'border-success-foreground/30 bg-success text-success-foreground'
              : 'border-error-foreground/30 bg-error text-error-foreground'
          }`}>
            {feedback.message}
          </div>
        )}

        {/* Four-tab workflow editor. Banners, save bar, and modals live at page
            level (outside the tabs) so the single unified save/dirty/validation
            lifecycle spans all four tabs. */}
        <ContentTabs
          value={activeTab}
          onValueChange={setActiveTab}
          items={[
            {
              value: 'statuses',
              label: 'Statuses',
              content: (
                <StatusDefinitionsSection
                  statuses={statuses}
                  savedStatusIds={savedStatusIds}
                  onUpdate={updateStatus}
                  onAdd={addStatus}
                  onRemove={removeStatus}
                  onReorder={(next) => { setStatuses(next); setDirty(true); }}
                />
              ),
            },
            {
              value: 'transitions',
              label: 'Transitions',
              problemCount: transitionProblems.length,
              content: (
                <TransitionsSection
                  value={transitions}
                  customizing={transitionsCustomizing}
                  statuses={statusOptions}
                  knownCommands={knownCommands}
                  onChange={onTransitionsChange}
                  onCustomize={onTransitionsCustomize}
                  disabled={saving}
                />
              ),
            },
            {
              value: 'derive',
              label: 'Derive Rules',
              problemCount: deriveProblems.length,
              content: (
                <DeriveRulesSection
                  value={derive}
                  deriveCustom={deriveCustom}
                  statuses={statusOptions}
                  acceptedFacts={acceptedFacts}
                  onChange={onDeriveChange}
                  onReset={onDeriveReset}
                  disabled={saving}
                />
              ),
            },
            {
              value: 'facts',
              label: 'Facts',
              problemCount: factProblems.length,
              content: <FactsSection rows={factRows} onChange={onFactsChange} saving={saving} />,
            },
          ]}
        />

        {/* Save bar */}
        <div className="flex items-center gap-3">
          <button
            className="shell-action bg-primary/10 text-primary hover:bg-primary/20 disabled:opacity-50"
            onClick={() => void handleSave()}
            disabled={saving || !dirty || sectionProblems > 0}
          >
            <Save className="h-3.5 w-3.5" />
            {saving ? 'Saving...' : 'Save Configuration'}
          </button>
          {dirty && (
            <>
              <button
                className="shell-action text-xs"
                onClick={() => { setLoading(true); loadConfig(); }}
                disabled={saving}
              >
                Discard Changes
              </button>
              <span className="text-xs text-muted-foreground">
                {tabProblemSummary({
                  transitions: transitionProblems.length,
                  derive: deriveProblems.length,
                  facts: factProblems.length,
                }).message}
              </span>
            </>
          )}
        </div>

        {/* Orphan-prompt modal */}
        {modalState.open && (
          <StatusDeleteModal
            open={modalState.open}
            affected={{
              ...modalState.affected,
              label:
                statuses.find((s) => s.id === modalState.affected.id)?.label ??
                modalState.affected.id,
            }}
            remaining={statuses
              .filter((s) => s.id !== modalState.affected.id && savedStatusIds.has(s.id))
              .map((s) => ({ id: s.id, label: s.label }))}
            ruleReferences={modalState.ruleReferences}
            headlineReferences={modalState.headlineReferences}
            onResolve={handleModalResolve}
            onCancel={handleModalCancel}
          />
        )}

        {/* Fact-reference modal (unified save 409 ack) */}
        <FactDeleteModal
          open={factModal.open}
          references={factModal.open ? factModal.references : []}
          onConfirm={handleFactModalConfirm}
          onCancel={() => {
            setFactModal({ open: false });
            setSaving(false);
          }}
        />
      </div>
    </TooltipProvider>
  );
}
