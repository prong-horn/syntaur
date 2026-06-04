"""Syntaur Tier-3 enforcement plugin for Hermes Agent.

Registers two lifecycle hooks via `register(ctx)`:
  - pre_tool_call : block (best-effort) + log writes outside the assignment boundary
  - on_session_end: mark the Syntaur dashboard session "stopped"

plus the Syntaur slash commands. Stdlib only; never raises from a hook (the Hermes
handler contract). See README.md for the blocking-is-best-effort caveat.
"""

import json
import os
import subprocess
import sys
import urllib.request

from . import boundary

# Hermes write tools use the snake_case dialect (read_file / patch / terminal).
WRITE_TOOLS = {"patch", "write_file", "edit_file", "create_file", "apply_patch"}
PATH_KEYS = ("file_path", "path", "filename", "target_file")

# Slash commands match the bare CC/Codex names. Only `doctor-syntaur` shells out;
# the rest point the agent at the installed Tier-1 skill of the same name.
CORE_COMMANDS = [
    {"name": "doctor-syntaur", "description": "Run `syntaur doctor` diagnostics", "kind": "passthrough", "argv": ["doctor"]},
    {"name": "grab-assignment", "description": "Claim a Syntaur assignment into this session", "kind": "guidance", "skill": "grab-assignment"},
    {"name": "log-progress", "description": "Append a progress entry to the active assignment", "kind": "guidance", "skill": "log-progress"},
    {"name": "complete-assignment", "description": "Write a handoff and complete the assignment", "kind": "guidance", "skill": "complete-assignment"},
    {"name": "save-session-summary", "description": "Save a session continuity summary", "kind": "guidance", "skill": "save-session-summary"},
    {"name": "resume-session", "description": "Re-orient on the active assignment", "kind": "guidance", "skill": "resume-session"},
    {"name": "set-workspace", "description": "Set workspace fields on the active assignment", "kind": "guidance", "skill": "set-workspace"},
    {"name": "track-session", "description": "Register this session in the Syntaur dashboard", "kind": "guidance", "skill": "track-session"},
]


def _extract_write_path(tool_name, args):
    if not isinstance(tool_name, str) or tool_name.lower() not in WRITE_TOOLS:
        return None
    if not isinstance(args, dict):
        return None
    for k in PATH_KEYS:
        v = args.get(k)
        if isinstance(v, str) and v:
            return v
    return None


def _dashboard_port():
    env = os.environ.get("SYNTAUR_DASHBOARD_PORT")
    if env:
        return env
    try:
        with open(os.path.join(os.path.expanduser("~"), ".syntaur", "dashboard-port"), "r") as fh:
            return fh.read().strip() or "4800"
    except Exception:
        return "4800"


def _log_violation(reason):
    try:
        sys.stderr.write("[syntaur] " + reason + "\n")
    except Exception:
        pass
    try:
        log = os.path.join(os.path.expanduser("~"), ".syntaur", "tier3-violations.log")
        os.makedirs(os.path.dirname(log), exist_ok=True)
        with open(log, "a", encoding="utf-8") as fh:
            fh.write(reason + "\n")
    except Exception:
        pass


def _on_pre_tool_call(tool_name=None, args=None, task_id=None, **kwargs):
    """Block (best-effort) + log writes outside the assignment boundary."""
    try:
        path = _extract_write_path(tool_name, args)
        if not path:
            return None
        cwd = os.getcwd()
        ctx = boundary.load_context(cwd)
        if not ctx:
            return None
        abs_path = path if os.path.isabs(path) else os.path.join(cwd, path)
        context_file = os.path.join(cwd, ".syntaur", "context.json")
        allowed, reason = boundary.is_write_allowed(abs_path, ctx, context_file)
        if not allowed:
            _log_violation(reason)
            # Hermes' pre_tool_call blocking contract is version-dependent; return a
            # deny signal as a best-effort block. If ignored, the violation is logged.
            return {"allow": False, "reason": reason}
        return None
    except Exception:
        return None  # never raise from a hook


def _on_session_end(session_id=None, completed=None, interrupted=None, model=None, platform=None, **kwargs):
    """Mark the dashboard session stopped (best-effort)."""
    try:
        ctx = boundary.load_context(os.getcwd()) or {}
        sid = ctx.get("sessionId") or session_id
        if not sid:
            return None
        body = {"status": "stopped"}
        if ctx.get("projectSlug"):
            body["projectSlug"] = ctx["projectSlug"]
        url = "http://127.0.0.1:%s/api/agent-sessions/%s/status" % (_dashboard_port(), sid)
        req = urllib.request.Request(
            url,
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="PATCH",
        )
        try:
            urllib.request.urlopen(req, timeout=3)
        except Exception:
            pass
        return None
    except Exception:
        return None


def _make_command_handler(cmd):
    def handler(*args, **kwargs):
        if cmd["kind"] == "passthrough":
            try:
                out = subprocess.run(["syntaur"] + cmd["argv"], capture_output=True, text=True)
                return (out.stdout or "") + (out.stderr or "")
            except Exception as exc:
                return "Failed to run syntaur %s: %s" % (" ".join(cmd["argv"]), exc)
        return (
            'Follow the Syntaur "%s" skill (installed via skills). It derives the active '
            "assignment/session from .syntaur/context.json." % cmd["skill"]
        )

    return handler


def register(ctx):
    """Wire Syntaur's hooks + commands into Hermes. Called once at startup."""
    ctx.register_hook("pre_tool_call", _on_pre_tool_call)
    ctx.register_hook("on_session_end", _on_session_end)

    # Command registration is best-effort across Hermes versions.
    reg = getattr(ctx, "register_command", None)
    if callable(reg):
        for cmd in CORE_COMMANDS:
            try:
                reg(cmd["name"], _make_command_handler(cmd), description=cmd["description"])
            except Exception:
                pass
