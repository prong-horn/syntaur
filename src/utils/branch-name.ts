/**
 * Pure, dependency-free validator mirroring `git check-ref-format --branch`
 * for the common cases. Returns a human-readable error message, or `null` if
 * the name is a valid git branch name.
 *
 * This lives under `src/` (not `dashboard/`) for two reasons:
 *  1. The server (`src/dashboard/api-write.ts`) imports it for a fast pre-flight
 *     check before shelling out to git.
 *  2. The dashboard imports it via the `@shared/branch-name` alias so the modal
 *     gives instant inline feedback using the SAME rules — no client/server
 *     divergence.
 *  3. Vitest only includes `src/__tests__/**`, so a pure validator must live
 *     under `src/` to be unit-testable.
 *
 * The server additionally runs `git check-ref-format --branch <name>` as the
 * authoritative backstop, so this function only needs to agree with git on the
 * common cases — it does not have to be a perfect git oracle.
 */
export function validateBranchName(name: string): string | null {
  if (!name.trim()) return 'Branch name is required.';
  if (/\s/.test(name)) return 'Branch name cannot contain whitespace.';
  // Control chars, DEL, and the characters git forbids in ref names.
  if (/[\x00-\x1F\x7F~^:?*[\\]/.test(name)) {
    return 'Branch name cannot contain any of: ~ ^ : ? * [ \\ or control characters.';
  }
  if (name.startsWith('-')) return 'Branch name cannot start with "-".';
  if (name.startsWith('/') || name.endsWith('/')) {
    return 'Branch name cannot start or end with "/".';
  }
  if (name.endsWith('.')) return 'Branch name cannot end with ".".';
  if (name.includes('..')) return 'Branch name cannot contain "..".';
  if (name.includes('@{')) return 'Branch name cannot contain "@{".';
  if (name === '@') return 'Branch name cannot be "@".';
  for (const segment of name.split('/')) {
    if (!segment) {
      return 'Branch name cannot contain empty path segments (e.g. "a//b").';
    }
    if (segment.startsWith('.')) {
      return 'Branch name segments cannot start with ".".';
    }
    if (segment.endsWith('.lock')) {
      return 'Branch name segments cannot end with ".lock".';
    }
  }
  return null;
}
