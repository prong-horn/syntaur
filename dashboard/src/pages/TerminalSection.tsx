import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { SectionCard } from '../components/SectionCard';
import { TERMINAL_CHOICES, type TerminalChoice } from '@shared/terminal-schema';
import {
  useTerminalConfig,
  saveTerminalConfig,
  resetTerminalConfig,
} from '../hooks/useTerminalConfig';

const LABELS: Record<TerminalChoice, string> = {
  'terminal-app': 'Terminal (macOS built-in)',
  iterm: 'iTerm2',
  ghostty: 'Ghostty',
  alacritty: 'Alacritty',
  warp: 'Warp',
  kitty: 'kitty',
};

interface Feedback {
  type: 'success' | 'error';
  message: string;
}

export function TerminalSection() {
  const { terminal, custom } = useTerminalConfig();
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  function flash(next: Feedback) {
    setFeedback(next);
    setTimeout(() => setFeedback(null), 2500);
  }

  async function handleChange(next: TerminalChoice) {
    if (next === terminal && custom) return;
    setSaving(true);
    try {
      await saveTerminalConfig(next);
      flash({ type: 'success', message: `Terminal set to ${LABELS[next]}.` });
    } catch (err) {
      flash({
        type: 'error',
        message: err instanceof Error ? err.message : 'Save failed.',
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    setSaving(true);
    try {
      const next = await resetTerminalConfig();
      flash({
        type: 'success',
        message: `Reset to OS default (${LABELS[next.terminal]}).`,
      });
    } catch (err) {
      flash({
        type: 'error',
        message: err instanceof Error ? err.message : 'Reset failed.',
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <SectionCard
      title="Terminal"
      description={`Which terminal "Open in agent" launches. Defaults to the OS choice (currently ${LABELS[terminal]}) when unset.`}
      actions={
        custom ? (
          <button
            className="shell-action text-xs"
            onClick={handleReset}
            disabled={saving}
            type="button"
          >
            <RotateCcw className="h-3 w-3" />
            Reset to OS default
          </button>
        ) : undefined
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
      <label className="block text-sm">
        <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
          Launch in
        </span>
        <select
          value={terminal}
          onChange={(e) => handleChange(e.target.value as TerminalChoice)}
          disabled={saving}
          className="w-full max-w-sm rounded-md border border-border/60 bg-background px-3 py-1.5 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60"
        >
          {TERMINAL_CHOICES.map((choice) => (
            <option key={choice} value={choice}>
              {LABELS[choice]}
            </option>
          ))}
        </select>
      </label>
    </SectionCard>
  );
}
