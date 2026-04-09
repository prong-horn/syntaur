# Syntaur

Syntaur is a local mission and assignment workflow for coding agents. It ships a CLI, a dashboard, a Claude Code plugin, and a Codex plugin.

## Install and Run

Requirements:

- Node.js 20+
- `npx` from npm

Run Syntaur directly with `npx`:

```bash
npx syntaur@latest
```

This downloads the published `syntaur` package into npm's cache and runs the CLI. It does not do a global install unless you choose to install it globally yourself.

On first run, Syntaur will:

1. Initialize `~/.syntaur/`
2. Offer to install the Claude Code plugin
3. Offer to install the Codex plugin
4. Ask where those plugins should be installed, with recommended defaults based on your current machine
5. Offer to launch the dashboard

You can also run setup explicitly:

```bash
npx syntaur@latest setup
```

Non-interactive setup:

```bash
npx syntaur@latest setup --yes
npx syntaur@latest setup --yes --claude
npx syntaur@latest setup --yes --codex
npx syntaur@latest setup --yes --dashboard
```

## Plugin Install Paths

Syntaur remembers the plugin install locations you choose in `~/.syntaur/config.md`.

Interactive commands will prompt for install locations:

```bash
npx syntaur@latest install-plugin
npx syntaur@latest install-codex-plugin
```

You can also set paths explicitly:

```bash
npx syntaur@latest install-plugin --target-dir ~/.claude/plugins/syntaur
npx syntaur@latest install-codex-plugin \
  --target-dir ~/plugins/syntaur \
  --marketplace-path ~/.agents/plugins/marketplace.json
```

Setup supports the same path overrides:

```bash
npx syntaur@latest setup \
  --claude \
  --claude-dir ~/.claude/plugins/syntaur \
  --codex \
  --codex-dir ~/plugins/syntaur \
  --codex-marketplace-path ~/.agents/plugins/marketplace.json
```

## Common Commands

```bash
npx syntaur@latest dashboard
npx syntaur@latest create-mission "My First Mission"
npx syntaur@latest create-assignment "Implement feature" --mission my-first-mission
npx syntaur@latest uninstall
npx syntaur@latest uninstall --all
```

## Uninstall

Remove Syntaur-managed Claude and Codex integrations:

```bash
npx syntaur@latest uninstall
```

Remove plugins and `~/.syntaur` data:

```bash
npx syntaur@latest uninstall --all
```

If your config points missions somewhere outside `~/.syntaur`, Syntaur will warn and leave that external directory alone.

## Development

```bash
npm install
npm run typecheck
npm test
npx vitest run src/__tests__/adapter-templates.test.ts
```

Repo-local plugin linking for development:

```bash
npx syntaur@latest install-plugin --link
npx syntaur@latest install-codex-plugin --link
```
