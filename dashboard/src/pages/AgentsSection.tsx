import { useState, useEffect, useMemo } from 'react';
import {
  GripVertical,
  Plus,
  Trash2,
  RotateCcw,
  Save,
  Info,
} from 'lucide-react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  PROMPT_ARG_POSITIONS,
  AGENT_ID_PATTERN,
  type AgentConfig,
  type PromptArgPosition,
} from '@shared/agents-schema';
import { SectionCard } from '../components/SectionCard';
import { slugify } from '../lib/slug';
import {
  useAgentsConfig,
  saveAgentsConfig,
  resetAgentsConfig,
  AgentsConfigError,
  type FieldError,
} from '../hooks/useAgentsConfig';
import { usePlaybooks } from '../hooks/useProjects';

/** Minimal shape of the playbook options passed down to each agent row. */
interface PlaybookOption {
  slug: string;
  name: string;
}

type FieldKey =
  | 'id'
  | 'label'
  | 'command'
  | 'args'
  | 'promptArgPosition'
  | 'resolveFromShellAliases'
  | 'default'
  | 'model'
  | 'playbook'
  | 'row';

interface EditableAgent {
  rowKey: string;
  id: string;
  originalId: string | null;
  isNew: boolean;
  idEditable: boolean;
  autoSlugFromLabel: boolean;
  label: string;
  command: string;
  argsText: string;
  promptArgPosition: PromptArgPosition;
  resolveFromShellAliases: boolean;
  default: boolean;
  model: string;
  playbook: string;
  fieldErrors: Partial<Record<FieldKey, string>>;
}

const PROMPT_ARG_LABEL: Record<PromptArgPosition, string> = {
  first: 'first',
  last: 'last',
  none: 'none',
};

function makeRowKey(): string {
  return `row_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
}

function hydrate(agents: AgentConfig[]): EditableAgent[] {
  return agents.map((a) => ({
    rowKey: makeRowKey(),
    id: a.id,
    originalId: a.id,
    isNew: false,
    idEditable: false,
    autoSlugFromLabel: false,
    label: a.label,
    command: a.command,
    argsText: a.args ? a.args.join(' ') : '',
    promptArgPosition: a.promptArgPosition ?? 'first',
    resolveFromShellAliases: a.resolveFromShellAliases ?? false,
    default: a.default ?? false,
    model: a.model ?? '',
    playbook: a.playbook ?? '',
    fieldErrors: {},
  }));
}

function buildPayload(rows: EditableAgent[]): AgentConfig[] {
  return rows.map((row) => {
    const agent: AgentConfig = {
      id: row.id,
      label: row.label,
      command: row.command,
    };
    const args = row.argsText.split(/[,\s]+/).filter(Boolean);
    if (args.length > 0) agent.args = args;
    if (row.promptArgPosition !== 'first') agent.promptArgPosition = row.promptArgPosition;
    if (row.resolveFromShellAliases) agent.resolveFromShellAliases = true;
    if (row.default) agent.default = true;
    if (row.model.trim()) agent.model = row.model.trim();
    if (row.playbook.trim()) agent.playbook = row.playbook.trim();
    return agent;
  });
}

function normalizeListBeforeSave(rows: EditableAgent[]): EditableAgent[] {
  if (rows.length === 0) return rows;
  let firstDefault = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].default) {
      firstDefault = i;
      break;
    }
  }
  return rows.map((row, i) => ({
    ...row,
    default: firstDefault === -1 ? i === 0 : i === firstDefault,
  }));
}

function attachFieldErrors(
  rows: EditableAgent[],
  fieldErrors: FieldError[] | undefined,
): EditableAgent[] {
  if (!fieldErrors || fieldErrors.length === 0) return rows;
  return rows.map((row, rowIndex) => {
    const next: Partial<Record<FieldKey, string>> = {};
    for (const fe of fieldErrors) {
      if (fe.index !== undefined) {
        if (fe.index === rowIndex) {
          next[fe.field as FieldKey] = fe.message;
        }
        continue;
      }
      if (fe.id !== undefined) {
        if (fe.id === row.id) {
          next[fe.field as FieldKey] = fe.message;
        }
        continue;
      }
      // No id and no index — true list-level error (e.g. "more than one default").
      next[fe.field as FieldKey] = fe.message;
    }
    return { ...row, fieldErrors: next };
  });
}

function clearFieldErrors(rows: EditableAgent[]): EditableAgent[] {
  return rows.map((row) =>
    Object.keys(row.fieldErrors).length === 0 ? row : { ...row, fieldErrors: {} },
  );
}

function rowsAreEqual(a: EditableAgent[], b: EditableAgent[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i];
    const bi = b[i];
    if (
      ai.id !== bi.id ||
      ai.label !== bi.label ||
      ai.command !== bi.command ||
      ai.argsText !== bi.argsText ||
      ai.promptArgPosition !== bi.promptArgPosition ||
      ai.resolveFromShellAliases !== bi.resolveFromShellAliases ||
      ai.default !== bi.default ||
      ai.model !== bi.model ||
      ai.playbook !== bi.playbook
    ) {
      return false;
    }
  }
  return true;
}

interface SortableAgentRowProps {
  row: EditableAgent;
  index: number;
  canRemove: boolean;
  playbooks: PlaybookOption[];
  onPatch: (patch: Partial<EditableAgent>) => void;
  onSetDefault: () => void;
  onRemove: () => void;
}

function SortableAgentRow({
  row,
  index,
  canRemove,
  playbooks,
  onPatch,
  onSetDefault,
  onRemove,
}: SortableAgentRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: row.rowKey });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : undefined,
    position: isDragging ? ('relative' as const) : undefined,
  };

  function handleLabelChange(value: string) {
    const patch: Partial<EditableAgent> = { label: value };
    if (row.autoSlugFromLabel) {
      const slug = slugify(value);
      if (slug && AGENT_ID_PATTERN.test(slug)) {
        patch.id = slug;
      } else {
        patch.id = `agent-${index + 1}`;
      }
    }
    onPatch(patch);
  }

  function handleIdChange(value: string) {
    onPatch({ id: value, autoSlugFromLabel: false });
  }

  const errorClass = (field: FieldKey) =>
    row.fieldErrors[field] ? 'border-error-foreground/60' : '';

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`surface-panel space-y-2 px-3 py-2 ${isDragging ? 'opacity-60 shadow-lg' : ''}`}
    >
      <div className="flex items-center gap-2">
        <button
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          type="button"
          aria-label="Drag to reorder"
          className="cursor-grab active:cursor-grabbing text-muted-foreground/40 hover:text-muted-foreground transition touch-none"
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="radio"
            name="agents-default"
            checked={row.default}
            onChange={onSetDefault}
            className="h-3 w-3 cursor-pointer accent-foreground"
          />
          Default
        </label>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[10px] font-mono uppercase tracking-wide text-muted-foreground/70">
            id
          </span>
          {row.idEditable ? (
            <input
              type="text"
              value={row.id}
              onChange={(e) => handleIdChange(e.target.value)}
              className={`editor-input w-32 font-mono text-xs ${errorClass('id')}`}
              aria-label="Agent id"
            />
          ) : (
            <span className="font-mono text-xs text-muted-foreground">{row.id}</span>
          )}
          <button
            type="button"
            onClick={onRemove}
            disabled={!canRemove}
            aria-label="Remove agent"
            className="rounded p-1 text-muted-foreground/60 transition hover:bg-foreground/[0.04] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      {row.fieldErrors.id && (
        <p className="ml-7 text-[11px] text-error-foreground">{row.fieldErrors.id}</p>
      )}

      <div className="ml-7 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div>
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground/80">
            Label
          </label>
          <input
            type="text"
            value={row.label}
            onChange={(e) => handleLabelChange(e.target.value)}
            className={`editor-input mt-0.5 w-full ${errorClass('label')}`}
          />
          {row.fieldErrors.label && (
            <p className="mt-0.5 text-[11px] text-error-foreground">{row.fieldErrors.label}</p>
          )}
        </div>
        <div>
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground/80">
            Command
          </label>
          <input
            type="text"
            value={row.command}
            placeholder="claude or /usr/local/bin/claude"
            onChange={(e) => onPatch({ command: e.target.value })}
            className={`editor-input mt-0.5 w-full font-mono ${errorClass('command')}`}
          />
          {row.fieldErrors.command && (
            <p className="mt-0.5 text-[11px] text-error-foreground">{row.fieldErrors.command}</p>
          )}
        </div>
        <div>
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground/80">
            Args (comma- or space-separated)
          </label>
          <input
            type="text"
            value={row.argsText}
            placeholder="--dangerously-skip-permissions"
            onChange={(e) => onPatch({ argsText: e.target.value })}
            className={`editor-input mt-0.5 w-full font-mono ${errorClass('args')}`}
          />
          {row.fieldErrors.args && (
            <p className="mt-0.5 text-[11px] text-error-foreground">{row.fieldErrors.args}</p>
          )}
        </div>
        <div>
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground/80">
            Prompt arg position
          </label>
          <select
            value={row.promptArgPosition}
            onChange={(e) =>
              onPatch({ promptArgPosition: e.target.value as PromptArgPosition })
            }
            className={`editor-input mt-0.5 w-full ${errorClass('promptArgPosition')}`}
          >
            {PROMPT_ARG_POSITIONS.map((p) => (
              <option key={p} value={p}>
                {PROMPT_ARG_LABEL[p]}
              </option>
            ))}
          </select>
          {row.fieldErrors.promptArgPosition && (
            <p className="mt-0.5 text-[11px] text-error-foreground">
              {row.fieldErrors.promptArgPosition}
            </p>
          )}
        </div>
        <div>
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground/80">
            Model
          </label>
          <input
            type="text"
            value={row.model}
            placeholder="opus (optional)"
            onChange={(e) => onPatch({ model: e.target.value })}
            className={`editor-input mt-0.5 w-full font-mono ${errorClass('model')}`}
          />
          {row.fieldErrors.model && (
            <p className="mt-0.5 text-[11px] text-error-foreground">{row.fieldErrors.model}</p>
          )}
        </div>
        <div>
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground/80">
            Playbook
          </label>
          <select
            value={row.playbook}
            onChange={(e) => onPatch({ playbook: e.target.value })}
            className={`editor-input mt-0.5 w-full ${errorClass('playbook')}`}
          >
            <option value="">— none —</option>
            {playbooks.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.name}
              </option>
            ))}
            {/* Preserve a stale/disabled slug that isn't in the enabled list. */}
            {row.playbook && !playbooks.some((p) => p.slug === row.playbook) && (
              <option value={row.playbook}>{row.playbook} (unavailable)</option>
            )}
          </select>
          {row.fieldErrors.playbook && (
            <p className="mt-0.5 text-[11px] text-error-foreground">{row.fieldErrors.playbook}</p>
          )}
        </div>
        <label className="col-span-full inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={row.resolveFromShellAliases}
            onChange={(e) => onPatch({ resolveFromShellAliases: e.target.checked })}
            className="h-3.5 w-3.5 cursor-pointer accent-foreground"
          />
          Resolve from shell aliases (look up <code className="font-mono">command</code> in your interactive shell before launching)
        </label>
      </div>
    </div>
  );
}

export function AgentsSection() {
  const serverState = useAgentsConfig();
  const playbooksState = usePlaybooks();
  const playbookOptions = useMemo<PlaybookOption[]>(
    () =>
      (playbooksState.data?.playbooks ?? [])
        .filter((p) => p.enabled)
        .map((p) => ({ slug: p.slug, name: p.name })),
    [playbooksState.data],
  );
  const [rows, setRows] = useState<EditableAgent[]>(() => hydrate(serverState.agents));
  const [hydrated, setHydrated] = useState<EditableAgent[]>(() => hydrate(serverState.agents));
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(
    null,
  );

  useEffect(() => {
    const fresh = hydrate(serverState.agents);
    setRows(fresh);
    setHydrated(fresh);
    setBanner(null);
  }, [serverState.agents]);

  const dirty = useMemo(() => !rowsAreEqual(rows, hydrated), [rows, hydrated]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor),
  );

  function flash(type: 'success' | 'error', message: string) {
    setFeedback({ type, message });
    setTimeout(() => setFeedback(null), 2500);
  }

  function patchRow(rowKey: string, patch: Partial<EditableAgent>) {
    setRows((prev) =>
      prev.map((r) =>
        r.rowKey === rowKey
          ? {
              ...r,
              ...patch,
              fieldErrors: stripErrorsForPatch(r.fieldErrors, patch),
            }
          : r,
      ),
    );
  }

  function setDefaultRow(rowKey: string) {
    setRows((prev) => prev.map((r) => ({ ...r, default: r.rowKey === rowKey })));
  }

  function addRow() {
    setRows((prev) => {
      const existing = new Set(prev.map((r) => r.id));
      const base = 'new-agent';
      let id = base;
      let n = 1;
      while (existing.has(id)) {
        n += 1;
        id = `${base}-${n}`;
      }
      const label = n === 1 ? 'New Agent' : `New Agent ${n}`;
      const next: EditableAgent = {
        rowKey: makeRowKey(),
        id,
        originalId: null,
        isNew: true,
        idEditable: true,
        autoSlugFromLabel: true,
        label,
        command: '',
        argsText: '',
        promptArgPosition: 'first',
        // Default ON: most user agents are alias-or-bare-name (e.g.
        // `claude`, `cc`, `cursor-agent`) where lazy-loaded zshrc setups
        // don't have the alias resolved by the time we type into the
        // new terminal. Opting in to `$SHELL -ic '<cmd>'` makes the
        // launch robust at the cost of one extra shell invocation per
        // launch (~50-200ms). Users can flip it off for absolute-path
        // binaries if they care about the startup overhead.
        resolveFromShellAliases: true,
        default: false,
        model: '',
        playbook: '',
        fieldErrors: {},
      };
      return [...prev, next];
    });
  }

  function removeRow(rowKey: string) {
    setRows((prev) => prev.filter((r) => r.rowKey !== rowKey));
  }

  async function handleSave() {
    setSaving(true);
    setBanner(null);
    try {
      const normalized = normalizeListBeforeSave(rows);
      const payload = buildPayload(normalized);
      const next = await saveAgentsConfig(payload);
      const fresh = hydrate(next.agents);
      setRows(fresh);
      setHydrated(fresh);
      flash('success', 'Agents saved');
    } catch (err) {
      if (err instanceof AgentsConfigError) {
        setBanner(err.message);
        setRows((prev) => attachFieldErrors(clearFieldErrors(prev), err.fieldErrors));
        flash('error', err.message);
      } else {
        const message = err instanceof Error ? err.message : 'Failed to save';
        setBanner(message);
        flash('error', message);
      }
    } finally {
      setSaving(false);
    }
  }

  function handleDiscard() {
    setRows(hydrated);
    setBanner(null);
  }

  async function handleReset() {
    if (!serverState.custom) return;
    if (!window.confirm('Reset agents to built-in defaults? Any custom agents will be deleted from your config.')) {
      return;
    }
    setSaving(true);
    setBanner(null);
    try {
      const next = await resetAgentsConfig();
      const fresh = hydrate(next.agents);
      setRows(fresh);
      setHydrated(fresh);
      flash('success', 'Reset to defaults');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to reset';
      setBanner(message);
      flash('error', message);
    } finally {
      setSaving(false);
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setRows((prev) => {
      const oldIndex = prev.findIndex((r) => r.rowKey === active.id);
      const newIndex = prev.findIndex((r) => r.rowKey === over.id);
      if (oldIndex === -1 || newIndex === -1) return prev;
      return arrayMove(prev, oldIndex, newIndex);
    });
  }

  return (
    <SectionCard
      title="Agents"
      description="Configure which agents the dashboard and 'Open in agent' actions can launch. The default agent is used when no other one is specified."
      actions={
        serverState.custom ? (
          <button
            type="button"
            className="shell-action text-xs"
            onClick={handleReset}
            disabled={saving}
          >
            <RotateCcw className="h-3 w-3" />
            Reset
          </button>
        ) : undefined
      }
    >
      {!serverState.custom && (
        <div className="flex items-start gap-2 rounded-md border border-border/60 bg-foreground/[0.02] px-3 py-2 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Using built-in defaults — first save will write your own list to{' '}
            <code className="font-mono">~/.syntaur/config.md</code>.
          </span>
        </div>
      )}

      {feedback && (
        <div
          className={`rounded-md border px-3 py-1.5 text-xs ${
            feedback.type === 'success'
              ? 'border-success-foreground/30 bg-success text-success-foreground'
              : 'border-error-foreground/30 bg-error text-error-foreground'
          }`}
        >
          {feedback.message}
        </div>
      )}

      {banner && (!feedback || feedback.type !== 'error') && (
        <div className="rounded-md border border-error-foreground/30 bg-error px-3 py-1.5 text-xs text-error-foreground">
          {banner}
        </div>
      )}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={rows.map((r) => r.rowKey)} strategy={verticalListSortingStrategy}>
          <div className="space-y-2">
            {rows.map((row, i) => (
              <SortableAgentRow
                key={row.rowKey}
                row={row}
                index={i}
                canRemove={rows.length > 1}
                playbooks={playbookOptions}
                onPatch={(patch) => patchRow(row.rowKey, patch)}
                onSetDefault={() => setDefaultRow(row.rowKey)}
                onRemove={() => removeRow(row.rowKey)}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={addRow}
          disabled={saving}
          className="shell-action text-xs"
        >
          <Plus className="h-3 w-3" />
          Add agent
        </button>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleDiscard}
            disabled={!dirty || saving}
            className="shell-action text-xs"
          >
            Discard
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!dirty || saving}
            className="shell-action text-xs"
          >
            <Save className="h-3 w-3" />
            Save
          </button>
        </div>
      </div>
    </SectionCard>
  );
}

function stripErrorsForPatch(
  errors: Partial<Record<FieldKey, string>>,
  patch: Partial<EditableAgent>,
): Partial<Record<FieldKey, string>> {
  if (Object.keys(errors).length === 0) return errors;
  const next = { ...errors };
  if ('id' in patch) delete next.id;
  if ('label' in patch) delete next.label;
  if ('command' in patch) delete next.command;
  if ('argsText' in patch) delete next.args;
  if ('promptArgPosition' in patch) delete next.promptArgPosition;
  if ('resolveFromShellAliases' in patch) delete next.resolveFromShellAliases;
  if ('default' in patch) delete next.default;
  if ('model' in patch) delete next.model;
  if ('playbook' in patch) delete next.playbook;
  return next;
}
