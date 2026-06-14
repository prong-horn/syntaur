import { useState } from 'react';
import { RotateCcw, Check } from 'lucide-react';
import { SectionCard } from '../components/SectionCard';
import { BackupSection } from '../components/BackupSection';
import { PRESETS, type ThemeSlug } from '../themes';
import { useTheme } from '../theme';
import { HotkeyBindingsSection } from './HotkeyBindingsSection';
import { ViewDefaultsSection } from './ViewDefaultsSection';
import { AgentsSection } from './AgentsSection';
import { TerminalSection } from './TerminalSection';
import { WorkspaceVisibilitySection } from './WorkspaceVisibilitySection';

export function SettingsPage() {
  const { preset, setPreset, resetPreset } = useTheme();
  const [themeSaving, setThemeSaving] = useState(false);
  const [themeFeedback, setThemeFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  async function handleThemeSelect(slug: ThemeSlug) {
    if (slug === preset || themeSaving) return;
    setThemeSaving(true);
    setThemeFeedback(null);
    try {
      await setPreset(slug);
      setThemeFeedback({ type: 'success', message: 'Theme updated' });
      setTimeout(() => setThemeFeedback(null), 2000);
    } catch (err) {
      setThemeFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to save theme',
      });
    } finally {
      setThemeSaving(false);
    }
  }

  async function handleThemeReset() {
    setThemeSaving(true);
    setThemeFeedback(null);
    try {
      await resetPreset();
      setThemeFeedback({ type: 'success', message: 'Theme reset to default' });
      setTimeout(() => setThemeFeedback(null), 2000);
    } catch (err) {
      setThemeFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to reset theme',
      });
    } finally {
      setThemeSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Theme */}
      <SectionCard
        title="Theme"
        description="Pick a color theme for the dashboard. The default is the Syntaur brand."
        actions={
          preset !== 'default' ? (
            <button
              className="shell-action text-xs"
              onClick={handleThemeReset}
              disabled={themeSaving}
            >
              <RotateCcw className="h-3 w-3" />
              Reset
            </button>
          ) : undefined
        }
      >
        {themeFeedback && (
          <div className={`mb-3 rounded-md border px-3 py-1.5 text-xs ${
            themeFeedback.type === 'success'
              ? 'border-success-foreground/30 bg-success text-success-foreground'
              : 'border-error-foreground/30 bg-error text-error-foreground'
          }`}>
            {themeFeedback.message}
          </div>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {PRESETS.map((p) => {
            const selected = p.slug === preset;
            return (
              <button
                key={p.slug}
                type="button"
                onClick={() => handleThemeSelect(p.slug)}
                disabled={themeSaving}
                aria-pressed={selected}
                className={`group relative flex flex-col gap-2 rounded-lg border bg-card/95 p-3 text-left transition disabled:opacity-60 ${
                  selected
                    ? 'border-primary ring-2 ring-primary/40'
                    : 'border-border/60 hover:border-primary/40'
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <span
                    className="h-5 w-5 rounded-full ring-1 ring-border/60"
                    style={{ background: p.swatches.primary }}
                  />
                  <span
                    className="h-5 w-5 rounded-full ring-1 ring-border/60"
                    style={{ background: p.swatches.secondary }}
                  />
                  <span
                    className="h-5 w-5 rounded-full ring-1 ring-border/60"
                    style={{ background: p.swatches.coral }}
                  />
                  <span
                    className="h-5 w-5 rounded-full ring-1 ring-border/60"
                    style={{ background: p.swatches.teal }}
                  />
                  <span
                    className="h-5 w-5 rounded-full ring-1 ring-border/60"
                    style={{ background: p.swatches.amber }}
                  />
                  {selected && (
                    <span className="ml-auto inline-flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                      <Check className="h-3 w-3" />
                    </span>
                  )}
                </div>
                <div>
                  <div className="text-sm font-medium text-foreground">{p.label}</div>
                  <div className="text-xs text-muted-foreground">{p.description}</div>
                </div>
              </button>
            );
          })}
        </div>
      </SectionCard>

      <HotkeyBindingsSection />

      <TerminalSection />

      <WorkspaceVisibilitySection />

      <AgentsSection />

      <ViewDefaultsSection />

      {/* GitHub Backup */}
      <BackupSection />
    </div>
  );
}
