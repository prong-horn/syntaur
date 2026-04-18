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

For Claude Code, Syntaur will detect the machine's local plugin marketplace when one exists and recommend installing into that marketplace's `plugins/` directory.

Interactive commands will prompt for install locations:

```bash
npx syntaur@latest install-plugin
npx syntaur@latest install-codex-plugin
```

You can also set paths explicitly:

```bash
npx syntaur@latest install-plugin --target-dir ~/.claude/plugins/marketplaces/user-plugins/plugins/syntaur
npx syntaur@latest install-codex-plugin \
  --target-dir ~/plugins/syntaur \
  --marketplace-path ~/.agents/plugins/marketplace.json
```

Setup supports the same path overrides:

```bash
npx syntaur@latest setup \
  --claude \
  --claude-dir ~/.claude/plugins/marketplaces/user-plugins/plugins/syntaur \
  --codex \
  --codex-dir ~/plugins/syntaur \
  --codex-marketplace-path ~/.agents/plugins/marketplace.json
```

## Common Commands

```bash
npx syntaur@latest dashboard
npx syntaur@latest create-mission "My First Mission"
npx syntaur@latest create-assignment "Implement feature" --mission my-first-mission
npx syntaur@latest doctor
npx syntaur@latest uninstall
npx syntaur@latest uninstall --all
```

## Troubleshooting

If Syntaur state looks inconsistent (missing files, stale manifests, hook blocks, etc.), run `syntaur doctor` to diagnose. Pass `--json` for structured output suitable for agents; the `/doctor-syntaur` slash command in the Claude Code plugin wraps it with interactive remediation.

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

## Release Publishing

This repo is set up for npm trusted publishing from GitHub Actions.

Release flow:

```bash
npm version patch
git push origin main
git push origin v$(node -p "require('./package.json').version")
```

The publish workflow lives at `.github/workflows/publish.yml` and only runs on version tags like `v0.1.4`. It checks that the tag matches `package.json`, runs the repo validation, and then publishes to npm using GitHub OIDC instead of a long-lived npm token.

One-time npm setup:

- package: `syntaur`
- GitHub repo: `prong-horn/syntaur`
- workflow filename: `publish.yml`

You can configure the trusted publisher either in the npm package settings UI or with npm CLI `11.10+`:

```bash
npx npm@^11.10.0 trust github syntaur --repo prong-horn/syntaur --file publish.yml -y
```

After trusted publishing is working, npm recommends switching the package publishing access to `Require two-factor authentication and disallow tokens`.
