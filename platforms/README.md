# Syntaur Adapters

Adapters generate framework-specific instruction files that teach non-Claude-Code
agents how to follow the Syntaur protocol. Each adapter produces files in the
format expected by the target framework.

## Supported Frameworks

| Framework | Generated Files | Discovery Mechanism |
|-----------|----------------|---------------------|
| **Cursor** | `.cursor/rules/syntaur-protocol.mdc`, `.cursor/rules/syntaur-assignment.mdc` | Cursor reads `.cursor/rules/*.mdc` files with YAML frontmatter |
| **Codex** | `AGENTS.md` | Codex reads `AGENTS.md` at repo root |
| **OpenCode** | `AGENTS.md`, `opencode.json` | OpenCode reads `AGENTS.md` at project root, plus optional `opencode.json` |

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

3. **Update barrel exports** in `src/templates/index.ts` -- add the new render function
   and param type.

4. **Add a case** in `src/commands/setup-adapter.ts` for the new framework:
   - Add the framework name to `SUPPORTED_FRAMEWORKS`
   - Add the rendering and file-writing logic in the framework switch

5. **Add unit tests** in `src/__tests__/adapter-templates.test.ts` verifying
   the renderer produces correct output.

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
