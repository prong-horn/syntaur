# Syntaur Adapters

Adapters generate framework-specific instruction files that teach non-Claude-Code
agents how to follow the Syntaur protocol. Each adapter produces files in the
format expected by the target framework.

Adapters are the **Tier-2** layer. **Tier-1** (the actual `SKILL.md` skills) ships
to any agent via the open Agent Skills spec — see "Installing skills into any
agent" below.

## Supported Frameworks (Tier-2 protocol adapters)

Driven declaratively by the registry in `src/targets/registry.ts`.

| Framework | Generated Files | Discovery Mechanism |
|-----------|----------------|---------------------|
| **Cursor** | `.cursor/rules/syntaur-protocol.mdc`, `.cursor/rules/syntaur-assignment.mdc` | Cursor reads `.cursor/rules/*.mdc` files with YAML frontmatter |
| **Codex** | `AGENTS.md` | Codex reads `AGENTS.md` at repo root |
| **OpenCode** | `AGENTS.md`, `opencode.json` | OpenCode reads `AGENTS.md` at project root, plus optional `opencode.json` |
| **Pi** | `AGENTS.md` | Pi reads `AGENTS.md` or `CLAUDE.md` |
| **OpenClaw** | `AGENTS.md` | OpenClaw reads `AGENTS.md` (built on Pi) |
| **Hermes Agent** | `SOUL.md` | Hermes reads `SOUL.md` / context files |

**User-authored agents:** end users can register a brand-new Tier-1+Tier-2 agent
WITHOUT a Syntaur release by dropping a JSON descriptor in `~/.syntaur/targets/`.
See `references/user-targets.md`.

## Tier-3 deep enforcement plugins (pi / OpenClaw / Hermes)

Tier-3 brings the **same enforcement parity the Claude Code / Codex plugins have** —
write-boundary blocking + session cleanup + Syntaur slash commands — to agents that
support imperative plugins. Installed automatically when the agent is targeted
(`syntaur setup --target pi`); `syntaur doctor` reports Tier-3 install status.

| Agent | Plugin | Installed to | Enforcement |
|-------|--------|--------------|-------------|
| **Pi** | TypeScript extension (`platforms/pi/extensions/syntaur/`) | `~/.pi/agent/extensions/syntaur/` | `tool_call` → block out-of-boundary writes; `session_shutdown` → mark session stopped |
| **OpenClaw** | reuses the **pi** extension (runs on pi-coding-agent) | `~/.openclaw/extensions/syntaur/` | same as Pi |
| **Hermes** | Python plugin (`platforms/hermes/plugins/syntaur/`) | `~/.hermes/plugins/syntaur/` | `pre_tool_call` → log + best-effort block; `on_session_end` → mark session stopped |

Caveats (see each plugin's `README.md`): **OpenClaw** is assumed to run on
pi-coding-agent per the design memo — if a build diverges to its own plugin format,
only the install dir needs repointing. **Hermes** `pre_tool_call` blocking is
version-dependent (documented primarily as an observer hook), so the Hermes plugin
logs every violation in addition to returning a deny signal; verify hard-block
against your live runtime. The boundary logic for both is unit-tested in
`src/__tests__/pi-extension.test.ts` and `src/__tests__/hermes-plugin.test.ts`.

## Installing skills into any agent (Tier 1)

Syntaur's `skills/` directory is a valid Agent Skills source, so the skills
install into any of the ~56 agents the ecosystem supports via `npx skills add`:

```bash
# Turnkey (wraps `npx skills add` + writes the Tier-2 protocol files):
syntaur setup --target pi                 # or hermes, openclaw, cursor, opencode
syntaur setup --target hermes,openclaw    # several at once
syntaur setup --target pi --dry-run       # preview, write nothing

# Or use the Agent Skills CLI directly:
npx skills add prong-horn/syntaur --agent pi
```

If `npx` is unavailable, `syntaur setup --target <id>` falls back to copying the
bundled skills directly into the agent's skills dir. See
`references/tool-dialects.md` for the Syntaur-id ↔ skills.sh-id mapping.

### Channels

Two equivalent Tier-1 sources resolve the same 30 skills:

- **GitHub source** — `npx skills add prong-horn/syntaur` clones the repo and
  auto-discovers `skills/` (no index needed).
- **Branded HTTP source** — a spec-valid Agent Skills **v0.2.0** discovery index at
  `/.well-known/agent-skills/index.json`, generated from `skills/` by
  `scripts/build-skills-index.mjs` (per-skill `sha256:` digests; single-file skills
  ship as `skill-md`, the multi-file `syntaur-protocol` as a deterministic `archive`
  tar.gz) and deployed to **GitHub Pages** by `publish.yml` on each `v*` tag:

  ```bash
  # Pass the FULL URL (a bare host parses as a GitHub shorthand in skills.sh):
  npx skills add https://prong-horn.github.io/syntaur
  ```

  The index emits **index-directory-relative** `url`s, so it resolves correctly whether
  hosted under the project-Pages subpath (`/syntaur/`) or, later, a custom domain at an
  origin root — no regeneration needed to adopt a CNAME.

## Usage

```bash
# Generate Cursor adapter files in the current directory
syntaur setup-adapter cursor --project <project-slug> --assignment <assignment-slug>

# Generate Codex adapter files
syntaur setup-adapter codex --project <project-slug> --assignment <assignment-slug>

# Generate OpenCode adapter files
syntaur setup-adapter opencode --project <project-slug> --assignment <assignment-slug>

# Overwrite existing files
syntaur setup-adapter cursor --project my-project --assignment my-task --force
```

## What Gets Generated

All adapters embed equivalent protocol knowledge:
- **Directory structure** of `~/.syntaur/`
- **Write boundary rules** (which files the agent can and cannot modify)
- **Assignment lifecycle states** and valid transitions
- **CLI commands** for state transitions (`syntaur start`, `syntaur complete`, etc.)
- **Reading order** for project and assignment files
- **Current assignment context** (project slug, assignment slug, paths)

## Contributing a New Adapter

To add support for a new framework:

1. **Create a static template** in `adapters/<framework>/` -- a human-readable
   reference file showing the format. This is documentation, not a runtime asset.

2. **Create a TypeScript renderer** in `src/templates/<framework>.ts`:
   - Define a params interface with `projectSlug`, `assignmentSlug`, `projectDir`, `assignmentDir`
   - Export a render function returning the file content as a string
   - Embed protocol knowledge directly in the template literal (do not read files at runtime)

3. **Register the renderer** in `src/targets/renderers.ts` -- add a `RendererKey`
   in `src/targets/types.ts` and map it to the render function in the `RENDERERS` table.

4. **Add a descriptor** to the registry array in `src/targets/registry.ts` (the
   `SUPPORTED_FRAMEWORKS` switch was removed in the Phase-1 registry refactor):
   one `AgentTarget` with `id`, `displayName`, `detect`, optional `skillsDir`, and an
   `instructions.files[]` listing each protocol file + its `renderer` key.

   **No-code alternative:** end users can register a Tier-1+Tier-2 agent WITHOUT a
   Syntaur release by dropping a JSON descriptor in `~/.syntaur/targets/` -- see
   `references/user-targets.md`. Code changes here are only needed for built-in
   agents or new renderers.

5. **Add unit tests** in `src/__tests__/targets-registry.test.ts` /
   `src/__tests__/adapter-templates.test.ts` verifying the renderer produces correct output.

6. **Update this README** with the new framework in the table above.

## Format Notes

### Cursor (.mdc)
- Files go in `.cursor/rules/` directory
- Each file has YAML frontmatter with `description`, `globs`, and `alwaysApply` fields
- `alwaysApply: true` means the rule is always active (not scoped to specific files)
- Content is standard markdown after the frontmatter

### Codex (AGENTS.md)
- Single file at repo root
- Standard markdown, no frontmatter
- 32 KiB size limit
- Codex discovers files root-to-leaf (repo root AGENTS.md applies to all files)

### OpenCode (AGENTS.md + opencode.json)
- Same AGENTS.md as Codex
- Optional `opencode.json` at project root with an `instructions` array
- The instructions field provides additional pointers to Syntaur protocol files
