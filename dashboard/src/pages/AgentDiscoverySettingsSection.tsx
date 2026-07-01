import { useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import { SectionCard } from '../components/SectionCard';
import { useToast, Toaster } from '../components/Toast';
import {
  useAgentDiscoveryConfig,
  saveAgentDiscoveryConfig,
} from '../hooks/useAgentDiscoveryConfig';

/**
 * Settings controls for agent discovery: which sources feed the /agents register
 * tray, the directory scan roots, and the cwd a standalone claude agent launches
 * from. The everyday register/create UX lives on the /agents surface; this is the
 * admin knob for what that surface scans.
 */
export function AgentDiscoverySettingsSection() {
  const { settings, loading, reload } = useAgentDiscoveryConfig();
  const { toast, showToast, dismissToast } = useToast();
  const [claudeGlobal, setClaudeGlobal] = useState(true);
  const [claudeProject, setClaudeProject] = useState(true);
  const [directory, setDirectory] = useState(true);
  const [rootsText, setRootsText] = useState('~');
  const [standaloneCwd, setStandaloneCwd] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (loading) return;
    setClaudeGlobal(settings.agentDiscovery.claudeGlobal);
    setClaudeProject(settings.agentDiscovery.claudeProject);
    setDirectory(settings.agentDiscovery.directory);
    setRootsText(settings.agentDiscovery.roots.join(', '));
    setStandaloneCwd(settings.standaloneDefaultCwd ?? '');
  }, [loading, settings]);

  async function save(): Promise<void> {
    setSaving(true);
    try {
      const roots = rootsText
        .split(/[,\n]+/)
        .map((r) => r.trim())
        .filter(Boolean);
      await saveAgentDiscoveryConfig({
        agentDiscovery: {
          claudeGlobal,
          claudeProject,
          directory,
          roots: roots.length ? roots : ['~'],
        },
        standaloneDefaultCwd: standaloneCwd.trim() || null,
      });
      showToast('Discovery settings saved', 'success');
      reload();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  }

  const field =
    'rounded-md border border-border/70 bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/60';

  const sources: Array<[boolean, (v: boolean) => void, string, string]> = [
    [claudeGlobal, setClaudeGlobal, 'Claude · global', '~/.claude/agents'],
    [claudeProject, setClaudeProject, 'Claude · project', 'each repo’s .claude/agents'],
    [directory, setDirectory, 'Directory scan', 'strong-marker dirs under the roots'],
  ];

  return (
    <SectionCard
      title="Agent discovery"
      description="Which sources feed the Agents page register tray, the directory scan roots, and where a standalone Claude agent launches from."
    >
      <fieldset className="space-y-2" disabled={loading || saving}>
        <legend className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Sources
        </legend>
        {sources.map(([checked, onChange, label, hint]) => (
          <label key={label} className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => onChange(e.target.checked)}
              className="size-4"
            />
            <span className="font-medium">{label}</span>
            <span className="text-xs text-muted-foreground">— {hint}</span>
          </label>
        ))}
      </fieldset>

      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Scan roots <span className="text-muted-foreground/50">(comma-separated; depth-1 dirs)</span>
        <input
          className={field}
          value={rootsText}
          onChange={(e) => setRootsText(e.target.value)}
          placeholder="~"
          disabled={loading || saving}
        />
      </label>

      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Standalone Claude cwd{' '}
        <span className="text-muted-foreground/50">(absolute path; blank → home)</span>
        <input
          className={field}
          value={standaloneCwd}
          onChange={(e) => setStandaloneCwd(e.target.value)}
          placeholder="/Users/you/work"
          disabled={loading || saving}
        />
      </label>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void save()}
          disabled={loading || saving}
          className="shell-action disabled:opacity-50"
        >
          <Save className="size-3.5" />
          <span>{saving ? 'Saving…' : 'Save'}</span>
        </button>
      </div>

      <Toaster toast={toast} onDismiss={dismissToast} />
    </SectionCard>
  );
}
