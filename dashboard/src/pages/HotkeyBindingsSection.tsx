import { useState } from 'react';
import { Keyboard, RotateCcw, X } from 'lucide-react';
import { SectionCard } from '../components/SectionCard';
import { useHotkeyContext } from '../hotkeys/HotkeyProvider';
import { formatPatternForDisplay, patternFromKeyboardEvent } from '../hotkeys/match';
import {
  BINDABLE_ACTION_KINDS,
  BINDABLE_ACTION_LABELS,
  type BindableActionKind,
} from '../hotkeys/bindableActions';
import {
  resetHotkeyBindings,
  saveHotkeyBindings,
} from '../hooks/useHotkeyBindings';

interface RecorderState {
  kind: BindableActionKind;
  combo: string | null;
  conflict: { description?: string; kind?: BindableActionKind } | null;
  saving: boolean;
  error: string | null;
}

export function HotkeyBindingsSection() {
  const {
    customBindings,
    userBindings,
    actionEntries,
    findConflict,
    bindAction,
    unbindAction,
  } = useHotkeyContext();

  const [recorder, setRecorder] = useState<RecorderState | null>(null);
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);
  const [resetting, setResetting] = useState(false);

  // Show "Reset all" only when the user has at least one custom override —
  // resetting clears overrides; defaults remain in effect.
  const hasAnyOverride = Object.values(userBindings).some(
    (v) => typeof v === 'string' && v.length > 0,
  );

  function showFeedback(type: 'success' | 'error', message: string) {
    setFeedback({ type, message });
    setTimeout(() => setFeedback(null), 2500);
  }

  function startRecording(kind: BindableActionKind) {
    setRecorder({
      kind,
      combo: null,
      conflict: null,
      saving: false,
      error: null,
    });
  }

  function handleRecorderKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!recorder) return;
    if (e.key === 'Escape') return;
    if (e.key === 'Enter' && recorder.combo) {
      e.preventDefault();
      void confirmRecorder();
      return;
    }
    if (e.key === 'Enter') return;
    e.preventDefault();
    e.stopPropagation();
    const combo = patternFromKeyboardEvent(e.nativeEvent);
    if (!combo) return;
    const conflict = findConflict(combo, recorder.kind);
    setRecorder({ ...recorder, combo, conflict, error: null });
  }

  async function confirmRecorder() {
    if (!recorder?.combo) return;
    if (recorder.conflict?.description) {
      setRecorder({
        ...recorder,
        error: `Reserved: ${recorder.conflict.description}`,
      });
      return;
    }
    setRecorder({ ...recorder, saving: true, error: null });
    try {
      await bindAction(recorder.kind, recorder.combo);
      setRecorder(null);
      showFeedback('success', `Bound ${BINDABLE_ACTION_LABELS[recorder.kind]}`);
    } catch (err) {
      setRecorder({
        ...recorder,
        saving: false,
        error: err instanceof Error ? err.message : 'Failed to save',
      });
    }
  }

  async function handleClear(kind: BindableActionKind) {
    try {
      await unbindAction(kind);
      showFeedback('success', `Cleared ${BINDABLE_ACTION_LABELS[kind]} binding`);
    } catch (err) {
      showFeedback(
        'error',
        err instanceof Error ? err.message : 'Failed to clear binding',
      );
    }
  }

  async function handleResetAll() {
    if (resetting) return;
    setResetting(true);
    try {
      await resetHotkeyBindings();
      showFeedback('success', 'All hotkey bindings cleared');
    } catch (err) {
      showFeedback(
        'error',
        err instanceof Error ? err.message : 'Failed to reset bindings',
      );
    } finally {
      setResetting(false);
    }
  }

  // Save shortcut for callers who set bindings directly via objects (kept for
  // future-proofing the section; not used in current UI flow).
  void saveHotkeyBindings;

  return (
    <SectionCard
      title="Hotkey Bindings"
      description="Each canonical create action ships with a default hotkey that fires the action without opening the palette. Override any of them below — Clear restores the default."
      actions={
        hasAnyOverride ? (
          <button
            className="shell-action text-xs"
            onClick={() => void handleResetAll()}
            disabled={resetting}
          >
            <RotateCcw className="h-3 w-3" />
            Restore defaults
          </button>
        ) : undefined
      }
    >
      {feedback ? (
        <div
          className={`mb-3 rounded-md border px-3 py-1.5 text-xs ${
            feedback.type === 'success'
              ? 'border-success-foreground/30 bg-success text-success-foreground'
              : 'border-error-foreground/30 bg-error text-error-foreground'
          }`}
        >
          {feedback.message}
        </div>
      ) : null}

      <ul className="space-y-2">
        {BINDABLE_ACTION_KINDS.map((kind) => {
          const action = actionEntries.find((a) => a.bindableKind === kind);
          const combo = customBindings[kind];
          const isCustom = typeof userBindings[kind] === 'string' && !!userBindings[kind];
          const recording = recorder?.kind === kind;
          return (
            <li
              key={kind}
              className="flex flex-wrap items-center gap-3 rounded-md border border-border/40 bg-background/60 px-3 py-2"
            >
              <Keyboard className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <div className="text-sm text-foreground">
                  {action?.title ?? BINDABLE_ACTION_LABELS[kind]}
                </div>
                {action?.subtitle ? (
                  <div className="text-xs text-muted-foreground">{action.subtitle}</div>
                ) : null}
              </div>

              {combo ? (
                <div className="flex shrink-0 items-center gap-1.5">
                  <kbd className="rounded border border-border/70 bg-muted px-2 py-0.5 font-mono text-xs text-foreground">
                    {formatPatternForDisplay(combo)}
                  </kbd>
                  <span
                    className={`text-[10px] uppercase tracking-wide ${
                      isCustom ? 'text-primary' : 'text-muted-foreground'
                    }`}
                  >
                    {isCustom ? 'custom' : 'default'}
                  </span>
                </div>
              ) : (
                <span className="shrink-0 text-xs text-muted-foreground">unbound</span>
              )}

              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  className="shell-action text-xs"
                  onClick={() => startRecording(kind)}
                >
                  {combo ? 'Rebind' : 'Bind'}
                </button>
                {isCustom ? (
                  <button
                    type="button"
                    className="shell-action text-xs"
                    onClick={() => void handleClear(kind)}
                    aria-label={`Restore default ${BINDABLE_ACTION_LABELS[kind]} binding`}
                  >
                    <X className="h-3 w-3" />
                    Restore default
                  </button>
                ) : null}
              </div>

              {recording ? (
                <div
                  className="mt-2 w-full rounded-md border border-primary/40 bg-primary/5 px-3 py-3 text-center outline-none"
                  tabIndex={0}
                  autoFocus
                  onKeyDown={handleRecorderKey}
                  onBlur={() => {
                    if (recorder?.kind === kind && !recorder.saving) setRecorder(null);
                  }}
                >
                  {recorder?.combo ? (
                    <div className="space-y-2">
                      <div className="text-base font-semibold tracking-wide text-foreground">
                        {formatPatternForDisplay(recorder.combo)}
                      </div>
                      {recorder.conflict?.description ? (
                        <div className="text-xs text-destructive">
                          Reserved: {recorder.conflict.description}
                        </div>
                      ) : recorder.conflict?.kind ? (
                        <div className="text-xs text-amber-500 dark:text-amber-400">
                          Already bound to "
                          {BINDABLE_ACTION_LABELS[recorder.conflict.kind]}". Press Enter to overwrite.
                        </div>
                      ) : (
                        <div className="text-xs text-muted-foreground">
                          Press Enter to save, Esc to cancel, any other key to retry.
                        </div>
                      )}
                      {recorder.error ? (
                        <div className="text-xs text-destructive">{recorder.error}</div>
                      ) : null}
                    </div>
                  ) : (
                    <div className="text-xs text-muted-foreground">
                      Press the key combination you want to bind…
                    </div>
                  )}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </SectionCard>
  );
}
