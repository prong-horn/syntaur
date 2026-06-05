"""Pure Syntaur write-boundary logic for the Hermes plugin.

Mirrors platforms/claude-code/hooks/enforce-boundaries.sh exactly. Kept dependency-free
(stdlib only) and side-effect-free so it can be unit-tested directly via `python3 -c`
from Syntaur's vitest suite.
"""

import json
import os


def _expand_home(p):
    if p == "~":
        return os.path.expanduser("~")
    if p.startswith("~/"):
        return os.path.join(os.path.expanduser("~"), p[2:])
    return p


def load_context(cwd):
    """Read <cwd>/.syntaur/context.json; return a dict or None (fail-open)."""
    path = os.path.join(cwd, ".syntaur", "context.json")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception:
        return None
    if not isinstance(data, dict):
        return None

    def s(key):
        v = data.get(key)
        return v if isinstance(v, str) and v else None

    def home(key):
        v = s(key)
        return _expand_home(v) if v else None

    return {
        "assignmentDir": home("assignmentDir"),
        "projectDir": home("projectDir"),
        "workspaceRoot": home("workspaceRoot"),
        "sessionId": s("sessionId"),
        "projectSlug": s("projectSlug"),
    }


def _norm(p):
    return os.path.normpath(os.path.abspath(p))


def _is_under(child, parent):
    """True if `child` is STRICTLY under `parent` (matches the bash "$X"/* test)."""
    if not parent:
        return False
    c = _norm(child)
    p = _norm(parent)
    if c == p:
        return False
    return c.startswith(p + os.sep)


def is_write_allowed(abs_file_path, ctx, context_file_abs=None):
    """Return (allowed: bool, reason: str|None) for a write to abs_file_path.

    Allowed when the path is under the assignment dir, under project
    resources/memories (excluding derived `_*` files), equal to the context file,
    or under the workspace root. Otherwise blocked.
    """
    # Parity with the bash hook (enforce-boundaries.sh:69): enforcement requires
    # BOTH assignmentDir and projectDir. If either is missing (standalone / old /
    # partially-written context), fail OPEN — allow everything.
    if not ctx.get("assignmentDir") or not ctx.get("projectDir"):
        return True, None

    f = _norm(abs_file_path)

    if ctx.get("assignmentDir") and _is_under(f, ctx["assignmentDir"]):
        return True, None

    project_dir = ctx.get("projectDir")
    if project_dir:
        for sub in ("resources", "memories"):
            d = os.path.join(project_dir, sub)
            if _is_under(f, d) and not os.path.basename(f).startswith("_"):
                return True, None

    if context_file_abs and f == _norm(context_file_abs):
        return True, None

    if ctx.get("workspaceRoot") and _is_under(f, ctx["workspaceRoot"]):
        return True, None

    reason = (
        "Syntaur write boundary violation: cannot write to '%s'. Allowed: assignment dir "
        "(%s), project resources/memories, workspace (%s)."
        % (f, ctx.get("assignmentDir") or "n/a", ctx.get("workspaceRoot") or "n/a")
    )
    return False, reason
