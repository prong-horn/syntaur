import { Loader2, RefreshCw } from 'lucide-react';
import {
  AGENT_COLORS,
  BASE_SYSTEM_PROMPT,
  modeChoices,
  pickerChoices,
  type AgentDraft,
} from '../../lib/agent-editor';
import { agentColorClasses } from '../../lib/chat-format';
import { cn } from '../../lib/utils';
import type { AgentTestResult, ChatHarnessSummary } from '../../lib/chat-types';
import { AgentTestResultLine } from './AgentTestResultLine';

export interface AgentDefinitionFormProps {
  draft: AgentDraft;
  errors: Record<string, string>;
  harnesses: ChatHarnessSummary[];
  mode: 'create' | 'edit';
  refreshing: boolean;
  onChange: (next: AgentDraft) => void;
  onRefresh: () => void;
  onSave: () => void;
  onTest?: () => void;
  dirty: boolean;
  saving: boolean;
  testResult?: AgentTestResult | 'loading' | null;
  serverError?: string | null;
  defaultUnsetError?: string | null;
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="mt-1 text-xs text-destructive">{message}</p>;
}

function ConfigPicker({
  label,
  draft,
  harness,
  kind,
  custom,
  onChange,
  onRefresh,
  refreshing,
}: {
  label: string;
  draft: AgentDraft;
  harness: ChatHarnessSummary | null;
  kind: 'model' | 'effort';
  custom: boolean;
  onChange: (next: AgentDraft) => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const current = kind === 'model' ? draft.model : draft.effort;
  const picker = pickerChoices(kind, harness, current);
  if (picker.hidden) {
    return (
      <div>
        <label className="text-sm font-medium">{label}</label>
        <p className="mt-1 text-xs text-muted-foreground">{picker.reason}</p>
      </div>
    );
  }

  const fieldKey = kind === 'model' ? 'model' : 'effort';
  const customKey = kind === 'model' ? 'modelCustom' : 'effortCustom';

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <label className="text-sm font-medium">{label}</label>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing || !harness?.installed}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          {refreshing ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RefreshCw className="h-3 w-3" />
          )}
          Refresh
        </button>
      </div>
      {picker.reason && picker.choices.length === 0 ? (
        <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">{picker.reason}</p>
      ) : null}
      {custom ? (
        <input
          type="text"
          value={current}
          onChange={(event) =>
            onChange({ ...draft, [fieldKey]: event.target.value, [customKey]: true })
          }
          className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
        />
      ) : (
        <select
          value={current}
          onChange={(event) => {
            const value = event.target.value;
            if (value === '__custom__') {
              onChange({ ...draft, [customKey]: true });
              return;
            }
            onChange({ ...draft, [fieldKey]: value, [customKey]: false });
          }}
          className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
        >
          <option value="">inherit</option>
          {picker.choices.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
          <option value="__custom__">Custom…</option>
        </select>
      )}
    </div>
  );
}

export function AgentDefinitionForm({
  draft,
  errors,
  harnesses,
  mode,
  refreshing,
  onChange,
  onRefresh,
  onSave,
  onTest,
  dirty,
  saving,
  testResult = null,
  serverError,
  defaultUnsetError,
}: AgentDefinitionFormProps) {
  const harness = harnesses.find((h) => h.id === draft.harness) ?? null;
  const modelPicker = pickerChoices('model', harness, draft.model);
  const effortPicker = pickerChoices('effort', harness, draft.effort);
  const modes = modeChoices(harness);

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <div>
        <label htmlFor="agent-id" className="text-sm font-medium">
          Id
        </label>
        <input
          id="agent-id"
          type="text"
          value={draft.id}
          readOnly={mode === 'edit'}
          disabled={mode === 'edit'}
          onChange={(event) => onChange({ ...draft, id: event.target.value })}
          className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm disabled:opacity-60"
        />
        <FieldError message={errors.id} />
      </div>

      <div>
        <label htmlFor="agent-name" className="text-sm font-medium">
          Name
        </label>
        <input
          id="agent-name"
          type="text"
          value={draft.name}
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
          className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
        />
        <FieldError message={errors.name} />
      </div>

      <div>
        <label htmlFor="agent-avatar" className="text-sm font-medium">
          Avatar
        </label>
        <input
          id="agent-avatar"
          type="text"
          value={draft.avatar}
          onChange={(event) => onChange({ ...draft, avatar: event.target.value })}
          placeholder="emoji or initials"
          className="mt-1 w-full max-w-xs rounded-md border border-border bg-background px-3 py-2 text-sm"
        />
        <FieldError message={errors.avatar} />
      </div>

      <div>
        <span className="text-sm font-medium">Colour</span>
        <div className="mt-2 flex flex-wrap gap-2">
          {AGENT_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              aria-label={color}
              aria-pressed={draft.color === color}
              onClick={() => onChange({ ...draft, color })}
              className={cn(
                'rounded-md px-3 py-1.5 text-xs font-medium capitalize ring-2 ring-offset-2 ring-offset-background',
                agentColorClasses(color),
                draft.color === color ? 'ring-foreground/40' : 'ring-transparent',
              )}
            >
              {color}
            </button>
          ))}
        </div>
        <FieldError message={errors.color} />
      </div>

      <div>
        <label htmlFor="agent-harness" className="text-sm font-medium">
          Harness
        </label>
        <select
          id="agent-harness"
          value={draft.harness}
          onChange={(event) =>
            onChange({ ...draft, harness: event.target.value as AgentDraft['harness'] })
          }
          className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
        >
          {harnesses.map((h) => (
            <option key={h.id} value={h.id}>
              {h.label}
              {h.installed ? '' : ' (not installed)'}
            </option>
          ))}
        </select>
        {harness && !harness.installed ? (
          <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
            Install with <code className="font-mono">{harness.installHint}</code>
          </p>
        ) : null}
        {harness?.auth.state === 'failed' && harness.auth.detail ? (
          <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
            {harness.auth.detail}
            {harness.auth.at ? ` — last checked ${harness.auth.at}` : ''}
          </p>
        ) : null}
        <FieldError message={errors.harness} />
      </div>

      <ConfigPicker
        label="Model"
        draft={draft}
        harness={harness}
        kind="model"
        custom={draft.modelCustom || modelPicker.custom}
        onChange={onChange}
        onRefresh={onRefresh}
        refreshing={refreshing}
      />

      {!effortPicker.hidden ? (
        <ConfigPicker
          label="Effort"
          draft={draft}
          harness={harness}
          kind="effort"
          custom={draft.effortCustom || effortPicker.custom}
          onChange={onChange}
          onRefresh={onRefresh}
          refreshing={refreshing}
        />
      ) : effortPicker.reason ? (
        <div>
          <span className="text-sm font-medium">Effort</span>
          <p className="mt-1 text-xs text-muted-foreground">{effortPicker.reason}</p>
        </div>
      ) : null}

      <div>
        <label htmlFor="agent-mode" className="text-sm font-medium">
          Mode
        </label>
        {draft.modeCustom ? (
          <input
            id="agent-mode"
            type="text"
            value={draft.mode}
            onChange={(event) => onChange({ ...draft, mode: event.target.value })}
            className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
        ) : (
          <select
            id="agent-mode"
            value={draft.mode}
            onChange={(event) => {
              const value = event.target.value;
              if (value === '__custom__') {
                onChange({ ...draft, modeCustom: true, mode: '' });
                return;
              }
              onChange({ ...draft, mode: value, modeCustom: false });
            }}
            className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          >
            {modes.map((m) => (
              <option key={m.value || 'inherit'} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        )}
      </div>

      <fieldset>
        <legend className="text-sm font-medium">Responds to</legend>
        <div className="mt-2 flex flex-wrap gap-4 text-sm">
          {(['mentions', 'all-human', 'none'] as const).map((value) => (
            <label key={value} className="flex items-center gap-2">
              <input
                type="radio"
                name="respondsTo"
                checked={draft.respondsTo === value}
                onChange={() => onChange({ ...draft, respondsTo: value })}
              />
              {value}
            </label>
          ))}
        </div>
        <FieldError message={errors.respondsTo} />
      </fieldset>

      <div>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.default}
            onChange={(event) => onChange({ ...draft, default: event.target.checked })}
            className="mt-1"
          />
          <span>
            Default agent
            <span className="block text-xs text-muted-foreground">
              Saving makes this the only default
            </span>
          </span>
        </label>
        {defaultUnsetError ? (
          <p className="mt-1 text-xs text-destructive">{defaultUnsetError}</p>
        ) : null}
      </div>

      <div>
        <label htmlFor="agent-description" className="text-sm font-medium">
          Description
        </label>
        <input
          id="agent-description"
          type="text"
          value={draft.description}
          onChange={(event) => onChange({ ...draft, description: event.target.value })}
          className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
        />
      </div>

      <div>
        <label htmlFor="agent-mcp" className="text-sm font-medium">
          MCP servers
        </label>
        <textarea
          id="agent-mcp"
          value={draft.mcpServersText}
          onChange={(event) => onChange({ ...draft, mcpServersText: event.target.value })}
          rows={2}
          placeholder="one server id per line"
          className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
        />
      </div>

      <div>
        <label htmlFor="agent-env" className="text-sm font-medium">
          Environment
        </label>
        <textarea
          id="agent-env"
          value={draft.envText}
          onChange={(event) => onChange({ ...draft, envText: event.target.value })}
          rows={3}
          placeholder="KEY=value per line"
          className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
        />
        <FieldError message={errors.envText} />
      </div>

      <div>
        <label htmlFor="agent-prompt" className="text-sm font-medium">
          System prompt
        </label>
        <textarea
          id="agent-prompt"
          value={draft.systemPrompt}
          onChange={(event) =>
            onChange({
              ...draft,
              systemPrompt: event.target.value,
              promptIsDefault: false,
            })
          }
          rows={8}
          placeholder={BASE_SYSTEM_PROMPT}
          className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
        />
        {draft.promptIsDefault || draft.systemPrompt.trim() === '' ? (
          <button
            type="button"
            className="mt-1 text-xs text-muted-foreground underline"
            onClick={() =>
              onChange({ ...draft, systemPrompt: '', promptIsDefault: true })
            }
          >
            Use the default prompt
          </button>
        ) : null}
      </div>

      {serverError ? <p className="text-sm text-destructive">{serverError}</p> : null}
      <AgentTestResultLine testResult={testResult} className="mt-1" />

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          disabled={saving}
          className="shell-action shell-action--cta disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {onTest ? (
          <button
            type="button"
            onClick={onTest}
            disabled={dirty || saving}
            title={dirty ? 'Save to test' : undefined}
            className="shell-action disabled:opacity-50"
          >
            Test
          </button>
        ) : null}
        {dirty && onTest ? (
          <span className="text-xs text-muted-foreground">Save to test</span>
        ) : null}
      </div>
    </form>
  );
}
