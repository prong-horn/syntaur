import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Keyboard } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '../components/ui/dialog';
import { rankAll } from './fuzzy';
import type { Action, PaletteFlowStep } from './actionsIndex';
import { useHotkeyContext } from './HotkeyProvider';
import { TextStep, PickerStep, StepHeader } from './CreateActionForms';
import { formatPatternForDisplay, patternFromKeyboardEvent } from './match';
import type { BindableActionKind } from './bindableActions';

interface ActionPaletteProps {
  entries: Action[];
}

interface RankableAction {
  type: string;
  title: string;
  subtitle?: string;
  keywords?: string[];
  action: Action;
}

interface FlowState {
  action: Action;
  stepIndex: number;
  values: Record<string, string>;
}

interface BindRecorderState {
  action: Action;
  /** Captured combo, in canonical form. Empty until the user presses a key. */
  combo: string | null;
  /** Latest conflict descriptor for the captured combo, if any. */
  conflict: { description?: string; kind?: BindableActionKind } | null;
  saving: boolean;
  error: string | null;
}

export function ActionPalette({ entries }: ActionPaletteProps) {
  const navigate = useNavigate();
  const {
    actionsPaletteOpen,
    closeActionsPalette,
    customBindings,
    bindAction,
    findConflict,
    pendingActionKind,
    consumePendingActionKind,
  } = useHotkeyContext();

  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [promptAction, setPromptAction] = useState<Action | null>(null);
  const [promptValue, setPromptValue] = useState('');
  const [flowState, setFlowState] = useState<FlowState | null>(null);
  const [bindRecorder, setBindRecorder] = useState<BindRecorderState | null>(null);
  const [running, setRunning] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const rankable: RankableAction[] = useMemo(
    () =>
      entries.map((a) => ({
        type: a.group.toLowerCase(),
        title: a.title,
        subtitle: a.subtitle,
        keywords: a.keywords,
        action: a,
      })),
    [entries],
  );

  const ranked = useMemo(() => rankAll(query, rankable, 50), [query, rankable]);

  useEffect(() => {
    setSelected(0);
  }, [query, actionsPaletteOpen]);

  // Reset everything when closed.
  useEffect(() => {
    if (!actionsPaletteOpen) {
      setQuery('');
      setPromptAction(null);
      setPromptValue('');
      setFlowState(null);
      setBindRecorder(null);
      setRunning(false);
      setErrorMessage(null);
    }
  }, [actionsPaletteOpen]);

  // When the palette opens with a pending bindable-action kind, auto-execute
  // that action (one-shot — consumed on read).
  useEffect(() => {
    if (!actionsPaletteOpen || !pendingActionKind) return;
    const kind = consumePendingActionKind();
    if (!kind) return;
    const action = entries.find((a) => a.bindableKind === kind);
    if (action) {
      void executeAction(action);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionsPaletteOpen, pendingActionKind]);

  // Scroll selected into view on selection change.
  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(
      `[data-palette-idx="${selected}"]`,
    );
    node?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  async function executeAction(action: Action) {
    if (running) return;
    if (action.flow && action.flow.steps.length > 0) {
      setFlowState({ action, stepIndex: 0, values: {} });
      setErrorMessage(null);
      return;
    }
    if (action.requiresInput) {
      setPromptAction(action);
      setPromptValue('');
      setErrorMessage(null);
      return;
    }
    if (!action.run) return;
    setRunning(true);
    setErrorMessage(null);
    try {
      await action.run();
      closeActionsPalette();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setRunning(false);
    }
  }

  async function submitFlowStep(value: string) {
    if (!flowState) return;
    const step = flowState.action.flow!.steps[flowState.stepIndex];
    const nextValues = { ...flowState.values, [step.id]: value };
    if (flowState.stepIndex + 1 < flowState.action.flow!.steps.length) {
      setFlowState({
        action: flowState.action,
        stepIndex: flowState.stepIndex + 1,
        values: nextValues,
      });
      return;
    }
    // Final step — submit.
    setRunning(true);
    setErrorMessage(null);
    try {
      await flowState.action.flow!.submit(nextValues, { navigate });
      closeActionsPalette();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setRunning(false);
    }
  }

  function stepBackInFlow() {
    if (!flowState) return;
    if (running) return;
    if (flowState.stepIndex === 0) {
      setFlowState(null);
      setErrorMessage(null);
      return;
    }
    setFlowState({
      action: flowState.action,
      stepIndex: flowState.stepIndex - 1,
      values: flowState.values,
    });
    setErrorMessage(null);
  }

  async function submitPrompt() {
    if (running) return;
    if (!promptAction?.requiresInput) return;
    const value = promptValue.trim();
    if (!value) return;
    setRunning(true);
    setErrorMessage(null);
    try {
      await promptAction.requiresInput.runWithInput(value);
      closeActionsPalette();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setRunning(false);
    }
  }

  function handlePickerKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((i) => Math.min(ranked.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      // Mod+Enter: open the bind recorder for the selected row (if bindable).
      e.preventDefault();
      const entry = ranked[selected];
      if (entry?.action.bindableKind) {
        setBindRecorder({
          action: entry.action,
          combo: null,
          conflict: null,
          saving: false,
          error: null,
        });
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const entry = ranked[selected];
      if (entry) executeAction(entry.action);
    }
  }

  function handlePromptKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitPrompt();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setPromptAction(null);
      setPromptValue('');
    }
  }

  function handleBindRecorderKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!bindRecorder) return;
    if (e.key === 'Escape') {
      // Don't capture Esc — let it close the recorder via the dialog handler.
      return;
    }
    if (e.key === 'Enter' && !bindRecorder.combo) {
      // Ignore bare Enter until a combo is recorded.
      return;
    }
    // Capture every other keystroke as the bind target.
    e.preventDefault();
    e.stopPropagation();
    const combo = patternFromKeyboardEvent(e.nativeEvent);
    if (!combo) return;
    const conflict = findConflict(combo, bindRecorder.action.bindableKind);
    setBindRecorder({
      ...bindRecorder,
      combo,
      conflict,
      error: null,
    });
  }

  async function confirmBind() {
    if (!bindRecorder || !bindRecorder.combo || !bindRecorder.action.bindableKind)
      return;
    if (bindRecorder.conflict?.description) {
      // Reserved combo — refuse.
      setBindRecorder({
        ...bindRecorder,
        error: `Reserved: ${bindRecorder.conflict.description}`,
      });
      return;
    }
    setBindRecorder({ ...bindRecorder, saving: true, error: null });
    try {
      await bindAction(bindRecorder.action.bindableKind, bindRecorder.combo);
      setBindRecorder(null);
    } catch (err) {
      setBindRecorder({
        ...bindRecorder,
        saving: false,
        error: err instanceof Error ? err.message : 'Failed to save binding',
      });
    }
  }

  const inPromptMode = promptAction !== null;
  const inFlowMode = flowState !== null;
  const inBindMode = bindRecorder !== null;
  const currentStep: PaletteFlowStep | null = flowState
    ? flowState.action.flow!.steps[flowState.stepIndex]
    : null;

  return (
    <Dialog
      open={actionsPaletteOpen}
      onOpenChange={(o) => (o ? null : closeActionsPalette())}
    >
      <DialogContent
        className="max-w-xl p-0 gap-0"
        onEscapeKeyDown={(e) => {
          if (running) return;
          if (inBindMode) {
            e.preventDefault();
            setBindRecorder(null);
            return;
          }
          if (inFlowMode) {
            e.preventDefault();
            stepBackInFlow();
            return;
          }
          if (inPromptMode) {
            e.preventDefault();
            setPromptAction(null);
            setPromptValue('');
            setErrorMessage(null);
          }
        }}
      >
        <DialogTitle className="sr-only">Actions palette</DialogTitle>

        {inBindMode && bindRecorder ? (
          <div onKeyDown={handleBindRecorderKeyDown} tabIndex={-1} autoFocus>
            <div className="flex items-center gap-2 border-b border-border/70 px-4 py-3">
              <Keyboard className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <span className="text-sm text-foreground">
                Bind hotkey for {bindRecorder.action.title}
              </span>
            </div>
            <div className="px-4 py-6 text-center">
              {bindRecorder.combo ? (
                <div className="space-y-3">
                  <div className="text-2xl font-semibold tracking-wide text-foreground">
                    {formatPatternForDisplay(bindRecorder.combo)}
                  </div>
                  {bindRecorder.conflict?.description ? (
                    <div className="text-sm text-destructive">
                      Reserved: {bindRecorder.conflict.description} (cannot bind)
                    </div>
                  ) : bindRecorder.conflict?.kind ? (
                    <div className="text-sm text-amber-500 dark:text-amber-400">
                      Already bound to "{bindRecorder.conflict.kind}". Press Enter to overwrite.
                    </div>
                  ) : (
                    <div className="text-sm text-muted-foreground">
                      Press Enter to save, or another key to retry.
                    </div>
                  )}
                  {bindRecorder.error ? (
                    <div className="text-sm text-destructive">{bindRecorder.error}</div>
                  ) : null}
                </div>
              ) : (
                <div className="text-sm text-muted-foreground">
                  Press the key combination you want to bind…
                </div>
              )}
            </div>
            <div className="flex items-center justify-between border-t border-border/70 px-3 py-2 text-[11px] text-muted-foreground">
              <span>any key records · Enter saves · Esc cancels</span>
              <span>{bindRecorder.saving ? 'Saving…' : ''}</span>
            </div>
            {/*
              Confirm-on-Enter is bound here so the user can save without
              clicking. We trigger via a hidden button to keep semantics clean.
            */}
            <button
              type="button"
              className="sr-only"
              onClick={() => void confirmBind()}
              data-bind-confirm
            />
            <input
              type="hidden"
              onKeyDown={(e) => {
                if (e.key === 'Enter') void confirmBind();
              }}
            />
          </div>
        ) : inFlowMode && currentStep && flowState ? (
          <>
            <StepHeader
              label={`${flowState.action.title} · ${currentStep.label}`}
              onBack={stepBackInFlow}
              disabled={running}
              stepCounter={{
                current: flowState.stepIndex + 1,
                total: flowState.action.flow!.steps.length,
              }}
            />
            {currentStep.kind === 'text' ? (
              <TextStep
                step={currentStep}
                initialValue={flowState.values[currentStep.id]}
                disabled={running}
                onSubmit={submitFlowStep}
              />
            ) : (
              <PickerStep
                step={currentStep}
                disabled={running}
                onSubmit={submitFlowStep}
              />
            )}
            {errorMessage ? (
              <div className="border-t border-border/70 bg-destructive/10 px-4 py-2 text-xs text-destructive">
                {errorMessage}
              </div>
            ) : null}
            <div className="flex items-center justify-between border-t border-border/70 px-3 py-2 text-[11px] text-muted-foreground">
              <span>↵ next · ← back · Esc back</span>
              <span>{running ? 'Running…' : ''}</span>
            </div>
          </>
        ) : inPromptMode ? (
          <>
            <div className="flex items-center gap-2 border-b border-border/70 px-4 py-3">
              <span className="shrink-0 rounded border border-border/70 bg-background/60 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {promptAction!.group}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                {promptAction!.title}
              </span>
            </div>
            <input
              autoFocus
              type="text"
              value={promptValue}
              onChange={(e) => setPromptValue(e.target.value)}
              onKeyDown={handlePromptKeyDown}
              placeholder={promptAction!.requiresInput!.placeholder}
              disabled={running}
              className="w-full border-0 border-b border-border/70 bg-transparent px-4 py-3 text-sm text-foreground outline-none focus:ring-0 disabled:opacity-60"
            />
            {errorMessage ? (
              <div className="border-b border-border/70 bg-destructive/10 px-4 py-2 text-xs text-destructive">
                {errorMessage}
              </div>
            ) : null}
            <div className="flex items-center justify-between border-t border-border/70 px-3 py-2 text-[11px] text-muted-foreground">
              <span>{'↵'} submit {'·'} Esc back</span>
              <span>{running ? 'Running…' : ''}</span>
            </div>
          </>
        ) : (
          <>
            <input
              autoFocus
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handlePickerKeyDown}
              placeholder="Run an action: new project, new todo, toggle…"
              disabled={running}
              className="w-full rounded-t-xl border-0 border-b border-border/70 bg-transparent px-4 py-3 text-sm text-foreground outline-none focus:ring-0 disabled:opacity-60"
            />
            {errorMessage ? (
              <div className="border-b border-border/70 bg-destructive/10 px-4 py-2 text-xs text-destructive">
                {errorMessage}
              </div>
            ) : null}
            <div ref={listRef} className="max-h-[60vh] overflow-y-auto p-1">
              {ranked.length === 0 ? (
                <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                  {query ? 'No matches' : 'Start typing to search actions'}
                </div>
              ) : (
                ranked.map((entry, idx) => {
                  const isSelected = idx === selected;
                  const bindable = entry.action.bindableKind;
                  const boundCombo = bindable ? customBindings[bindable] : undefined;
                  return (
                    <button
                      key={entry.action.id}
                      type="button"
                      data-palette-idx={idx}
                      onClick={() => executeAction(entry.action)}
                      onMouseEnter={() => setSelected(idx)}
                      disabled={running}
                      className={`group flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors disabled:opacity-60 ${
                        isSelected
                          ? 'bg-accent text-accent-foreground'
                          : 'hover:bg-accent/50 text-foreground'
                      }`}
                    >
                      <span className="shrink-0 rounded border border-border/70 bg-background/60 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        {entry.action.group}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{entry.action.title}</span>
                      {entry.action.subtitle ? (
                        <span className="shrink-0 truncate text-xs text-muted-foreground">
                          {entry.action.subtitle}
                        </span>
                      ) : null}
                      {boundCombo ? (
                        <span className="shrink-0 rounded border border-border/70 bg-background/60 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-foreground">
                          {formatPatternForDisplay(boundCombo)}
                        </span>
                      ) : null}
                      {bindable ? (
                        <span
                          role="button"
                          tabIndex={-1}
                          aria-label="Bind hotkey"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setBindRecorder({
                              action: entry.action,
                              combo: null,
                              conflict: null,
                              saving: false,
                              error: null,
                            });
                          }}
                          className={`shrink-0 inline-flex h-6 w-6 items-center justify-center rounded border border-border/70 bg-background/60 text-muted-foreground transition-opacity hover:text-foreground ${
                            isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                          }`}
                        >
                          <Keyboard className="h-3.5 w-3.5" aria-hidden="true" />
                        </span>
                      ) : null}
                    </button>
                  );
                })
              )}
            </div>
            <div className="flex items-center justify-between border-t border-border/70 px-3 py-2 text-[11px] text-muted-foreground">
              <span>{'↑↓'} navigate {'·'} {'↵'} run {'·'} ⌘↵ bind {'·'} Esc close</span>
              <span>{running ? 'Running…' : `${ranked.length} action${ranked.length === 1 ? '' : 's'}`}</span>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
