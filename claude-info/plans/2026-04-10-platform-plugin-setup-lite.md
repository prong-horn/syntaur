# Platform-Specific Plugin/Skill Setup System

**Date:** 2026-04-10
**Complexity:** medium
**Status:** draft

## Summary

Reorganize Syntaur's platform integration directories so each supported AI coding platform has its own top-level `platforms/<name>/` directory containing all setup info. During `syntaur setup`, offer automated installation for Claude Code and Codex (with CLI detection). Cursor and OpenCode get reference-only directories. The existing `plugin/` and `plugins/syntaur/` directories move into the new structure.

## Current State

- **Claude Code plugin:** `plugin/` (top-level) — `.claude-plugin/plugin.json`, skills/, hooks/, commands/, agents/, references/
- **Codex plugin:** `plugins/syntaur/` (top-level) — `.codex-plugin/plugin.json`, skills/, hooks.json, commands/, agents/, references/, scripts/
- **Adapters:** `adapters/` — cursor/, codex/, opencode/ (template files for per-project generation)
- **Install logic:** `src/utils/install.ts` — `PluginKind = 'claude' | 'codex'` (line 20), all path resolution functions branch on this type
- **Setup flow:** `src/commands/setup.ts` — prompts for Claude plugin + Codex plugin + dashboard
- **Config:** `src/utils/config.ts` — `IntegrationConfig` stores `claudePluginDir`, `codexPluginDir`, `codexMarketplacePath` (lines 31-35)
- **Package files:** `package.json` `files` array includes `"plugin"` and `"plugins"` (lines 26-34)

## Architecture

### New Directory Layout

```
platforms/
├── claude-code/
│   ├── .claude-plugin/
│   │   └── plugin.json          # existing, moved from plugin/.claude-plugin/
│   ├── skills/                   # existing, moved from plugin/skills/
│   ├── hooks/                    # existing, moved from plugin/hooks/
│   ├── commands/                 # existing, moved from plugin/commands/
│   ├── agents/                   # existing, moved from plugin/agents/
│   ├── references/               # existing, moved from plugin/references/
│   └── README.md                 # setup instructions + platform docs reference
├── codex/
│   ├── .codex-plugin/
│   │   └── plugin.json          # existing, moved from plugins/syntaur/.codex-plugin/
│   ├── skills/                   # existing, moved from plugins/syntaur/skills/
│   ├── hooks.json                # existing, moved from plugins/syntaur/hooks.json
│   ├── commands/                 # existing, moved from plugins/syntaur/commands/
│   ├── agents/                   # existing, moved from plugins/syntaur/agents/
│   ├── references/               # existing, moved from plugins/syntaur/references/
│   ├── scripts/                  # existing, moved from plugins/syntaur/scripts/
│   └── README.md                 # setup instructions + platform docs reference
├── cursor/
│   ├── README.md                 # reference docs: how Cursor rules work, manual setup steps
│   └── adapters/                 # moved from adapters/cursor/
│       └── syntaur-protocol.mdc
└── opencode/
    ├── README.md                 # reference docs: how OpenCode skills work, manual setup steps
    └── adapters/                 # moved from adapters/opencode/
        └── opencode.json.template
```

The `adapters/codex/` content moves into `platforms/codex/adapters/` to keep everything per-platform.

### Key Decision: Move vs Symlink

**Move** the directories and update all path references. Don't leave old directories behind — that creates confusion. The `adapters/` directory goes away entirely.

---

## Tasks

### Task 1: Create `platforms/` directory structure and move files

**Files to create/move:**

1. Move `plugin/` → `platforms/claude-code/`
2. Move `plugins/syntaur/` → `platforms/codex/`
3. Move `adapters/cursor/` → `platforms/cursor/adapters/`
4. Move `adapters/codex/` → `platforms/codex/adapters/`
5. Move `adapters/opencode/` → `platforms/opencode/adapters/`
6. Remove empty `plugin/`, `plugins/`, `adapters/` directories
7. Create `platforms/cursor/README.md` — reference docs on Cursor rules (`.cursor/rules/*.mdc`, YAML frontmatter, `alwaysApply`, manual setup instructions, link to https://cursor.com/docs/plugins)
8. Create `platforms/opencode/README.md` — reference docs on OpenCode skills (`.opencode/skills/<name>/SKILL.md` or `.claude/skills/`, also reads `.agents/skills/`, global at `~/.config/opencode/skills/`, link to https://opencode.ai/docs/skills/)
9. Create `platforms/claude-code/README.md` — setup instructions, link to Claude Code plugin docs
10. Create `platforms/codex/README.md` — setup instructions, marketplace setup, link to Codex plugin docs

### Task 2: Update `src/utils/install.ts` path references

**`getPluginRelativePath` (line 159-161):**
```typescript
// Before:
return pluginKind === 'claude' ? 'plugin' : 'plugins/syntaur';
// After:
return pluginKind === 'claude' ? 'platforms/claude-code' : 'platforms/codex';
```

**`getPluginManifestRelativePath` (line 163-167):** No change needed — these are relative to the plugin dir, not the package root.

### Task 3: Update `package.json` files array

```json
// Before:
"files": ["dist", "bin", ".agents", "plugins", "plugin", "examples", "dashboard/dist"]

// After:
"files": ["dist", "bin", ".agents", "platforms", "examples", "dashboard/dist"]
```

Replace `"plugins"` and `"plugin"` with `"platforms"`.

### Task 4: Update `AGENTS.md` alignment rules

`AGENTS.md` at repo root currently references keeping `plugin/`, `plugins/syntaur/`, and adapter templates aligned. Update these references to the new `platforms/` paths.

### Task 5: Add CLI detection to setup flow

**File:** `src/commands/setup.ts`

Before prompting "Install the Claude Code plugin?", check if the `claude` CLI is available. Before prompting "Install the Codex plugin?", check if the `codex` CLI is available.

```typescript
import { execSync } from 'node:child_process';

function isCliInstalled(command: string): boolean {
  try {
    execSync(`which ${command}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
```

Update the interactive prompts in `setupCommand` (~line 47-57):

```typescript
if (interactive && !options.yes) {
  const claudeAvailable = isCliInstalled('claude');
  if (!options.claude) {
    if (!claudeAvailable) {
      console.log('Claude Code CLI not detected. Install it from https://claude.ai/download');
      installClaude = await confirmPrompt('Install the Claude Code plugin anyway?', false);
    } else {
      installClaude = await confirmPrompt('Install the Claude Code plugin?');
    }
  }

  const codexAvailable = isCliInstalled('codex');
  if (!options.codex) {
    if (!codexAvailable) {
      console.log('Codex CLI not detected. Install it from https://platform.openai.com/docs/codex');
      installCodex = await confirmPrompt('Install the Codex plugin anyway?', false);
    } else {
      installCodex = await confirmPrompt('Install the Codex plugin?');
    }
  }

  if (!options.dashboard) {
    launchDashboard = await confirmPrompt('Launch the dashboard now?', true);
  }
}
```

The user can still install even if the CLI isn't detected (non-blocking), but the default flips to `false` and a message explains the situation.

### Task 6: Update adapter template references

**File:** `src/commands/setup-adapter.ts` — no functional change needed (adapters are generated into the working directory at runtime, they don't read from the source adapter templates).

**File:** `src/templates/` — these are TypeScript renderers, not file-path dependent. No change needed.

### Task 7: Update tests

**File:** `src/__tests__/setup-install.test.ts`

Update any references to `plugin/` or `plugins/syntaur/` source paths to `platforms/claude-code/` and `platforms/codex/`. The test uses `findPackageRoot()` + `getPluginRelativePath()` so most should update automatically via Task 2, but verify snapshot/hardcoded paths.

**File:** `src/__tests__/adapter-templates.test.ts` — no change needed (tests renderer output, not source paths).

### Task 8: Verify and run

1. `npm run typecheck`
2. `npx vitest run`
3. Test `syntaur setup` interactively with Claude CLI present / absent
4. Test `syntaur install-plugin` and `syntaur install-codex-plugin` still work
5. Test `syntaur setup-adapter cursor` still works
6. Verify `npm pack` includes the `platforms/` directory

---

## Build Sequence

1. Task 1 (move files) — must be first since everything depends on new paths
2. Tasks 2 + 3 (install.ts + package.json) — can be parallel, both are path updates
3. Task 4 (AGENTS.md) — independent
4. Task 5 (CLI detection) — independent of file moves
5. Task 6 (verify adapters) — quick check
6. Task 7 (tests) — after path updates
7. Task 8 (verify) — last

## Files Changed Summary

| File | Change |
|------|--------|
| `platforms/` (new) | New top-level dir with all 4 platform subdirs |
| `plugin/` (removed) | Moved to `platforms/claude-code/` |
| `plugins/` (removed) | Moved to `platforms/codex/` |
| `adapters/` (removed) | Contents distributed into platform dirs |
| `src/utils/install.ts:159-161` | Update `getPluginRelativePath()` paths |
| `src/commands/setup.ts:47-57` | Add CLI detection before install prompts |
| `package.json:26-34` | Replace `plugin`/`plugins` with `platforms` in `files` |
| `AGENTS.md` | Update directory references |
| `src/__tests__/setup-install.test.ts` | Update any hardcoded source paths |
| `platforms/*/README.md` (4 new) | Platform-specific setup/reference docs |
