#!/usr/bin/env python3
"""Consent-based, local-only Codex hook collector. Python 3.10+ stdlib only.

The hook path is intentionally silent: it does not echo, persist or parse nested
prompt/tool payloads. Only Codex common metadata and canonical tool_name are read.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import threading
import time
import uuid

EVENTS = {
    "SessionStart": "session_started",
    "UserPromptSubmit": "prompt_submitted",
    "PostToolUse": "tool_used",
    "Stop": "turn_finished",
    "SessionEnd": "session_ended",
}
SCHEMA = 1
MAX_INPUT = 2 * 1024 * 1024
MAX_FILE = 5 * 1024 * 1024
MAX_TOTAL = 50 * 1024 * 1024
KEEP_DAYS = 30
HOOK_MARKER = "GCR opt-in local collector"


def data_root() -> Path:
    """No network or roaming profile; fail closed outside a native Windows user."""
    if sys.platform != "win32" or not os.environ.get("LOCALAPPDATA"):
        raise RuntimeError("Only native Windows local sessions are supported")
    if os.environ.get("WSL_DISTRO_NAME") or os.environ.get("SSH_CONNECTION"):
        raise RuntimeError("Remote Codex sessions are not supported")
    return Path(os.environ["LOCALAPPDATA"]) / "GentleControlRoom" / "CodexActivity"


def codex_home() -> Path:
    return Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))).expanduser().resolve()


_local_gate = threading.RLock()


@contextmanager
def locked(root: Path):
    """Mutual exclusion across independently launched Codex hook processes."""
    root.mkdir(parents=True, exist_ok=True)
    lock_path = root / ".lock"
    # Serialize same-process threads before competing for the OS file lock.
    # The file lock still enforces exclusion across independently launched hooks.
    with _local_gate:
        with lock_path.open("a+b") as lock_file:
            lock_file.seek(0, os.SEEK_END)
            if lock_file.tell() == 0:
                lock_file.write(b"0")
                lock_file.flush()
            lock_file.seek(0)
            if os.name == "nt":
                import msvcrt
                for attempt in range(100):
                    try:
                        msvcrt.locking(lock_file.fileno(), msvcrt.LK_NBLCK, 1)
                        break
                    except OSError:
                        if attempt == 99:
                            raise
                        time.sleep(.02)
                try:
                    yield
                finally:
                    lock_file.seek(0)
                    msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl  # test harness on Unix; hook is Windows-only
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
                try:
                    yield
                finally:
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def atomic_json(path: Path, obj: dict) -> None:
    """Write a full file atomically, never leaving partially saved consent state."""
    path.parent.mkdir(parents=True, exist_ok=True)
    name = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, prefix=".tmp-", delete=False) as f:
            name = f.name
            json.dump(obj, f, indent=2, ensure_ascii=True)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(name, path)
    finally:
        if name and os.path.exists(name):
            os.unlink(name)


def read_config(root: Path) -> dict:
    path = root / "consent.json"
    if not path.is_file():
        return {"version": 1, "paused": True, "projects": [], "secret": None}
    obj = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(obj, dict) or obj.get("version") != 1 or not isinstance(obj.get("projects"), list):
        raise ValueError("Invalid consent config")
    if not isinstance(obj.get("paused"), bool):
        raise ValueError("Invalid pause state")
    return obj


def safe_project(path: Path) -> str:
    if not path.exists() or not path.is_dir():
        raise ValueError("Project directory does not exist")
    # Normalize case on Windows, resolve symlinks/junctions for scope comparison.
    return os.path.normcase(str(path.resolve(strict=True)))


def matching_project(config: dict, cwd: object) -> dict | None:
    if not isinstance(cwd, str) or not cwd or "\0" in cwd:
        return None
    try:
        resolved = safe_project(Path(cwd))
    except (ValueError, OSError, RuntimeError):
        return None
    matches = []
    for p in config.get("projects", []):
        if not isinstance(p, dict) or not isinstance(p.get("path"), str):
            continue
        root = os.path.normcase(p["path"])
        if resolved == root or resolved.startswith(root + os.sep):
            matches.append(p)
    return max(matches, key=lambda p: len(p["path"])) if matches else None


def tool_category(name: object) -> str:
    """Use canonical tool identifiers only. Never inspect commands or outputs."""
    if not isinstance(name, str):
        return "other"
    if name in {"apply_patch", "Edit", "Write"}:
        return "file_edit"
    if name in {"Bash", "exec_command", "functions.command", "write_stdin"}:
        return "shell"
    if name in {"run_tests", "run_test", "run_build"}:
        return "test_build"
    if name in {"read_file", "list_files", "grep", "search", "update_plan"}:
        return "inspect"
    if name == "Git":
        return "git"
    # Unknown MCP/tool identifiers may include sensitive names; never persist.
    return "other"


def event_from_payload(config: dict, payload: object, now: datetime | None = None) -> dict | None:
    if not isinstance(payload, dict) or config.get("paused") is not False:
        return None
    event_name = payload.get("hook_event_name")
    if event_name not in EVENTS:
        return None
    project = matching_project(config, payload.get("cwd"))
    if not project or not isinstance(project.get("id"), str):
        return None
    raw_session = payload.get("session_id")
    secret = config.get("secret")
    if not isinstance(raw_session, str) or not raw_session or len(raw_session) > 500 or not isinstance(secret, str):
        return None
    try:
        key = bytes.fromhex(secret)
        if len(key) != 32:
            return None
        pseudonym = hmac.new(key, raw_session.encode("utf-8"), hashlib.sha256).hexdigest()[:24]
    except (UnicodeError, ValueError):
        return None
    ts = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    result = {"schemaVersion": SCHEMA, "timestamp": ts.isoformat(timespec="seconds").replace("+00:00", "Z"),
              "eventType": EVENTS[event_name], "sessionPseudonym": pseudonym,
              "projectPseudonym": project["id"]}
    if event_name == "PostToolUse":
        result["toolCategory"] = tool_category(payload.get("tool_name"))
    return result


def event_files(root: Path) -> list[Path]:
    return sorted(root.glob("events-????????-*.jsonl"))


def retention(root: Path, now: datetime) -> None:
    cutoff = now.date() - timedelta(days=KEEP_DAYS - 1)
    for p in event_files(root):
        try:
            # file format events-YYYYMMDD-N.jsonl
            date_part = p.name[7:15]
            day = datetime.strptime(date_part, "%Y%m%d").date()
            if day < cutoff or day > now.date():
                p.unlink()
        except (ValueError, OSError):
            # Ignore malformed filenames; never read unrelated files.
            continue
    files = event_files(root)
    total = sum(p.stat().st_size for p in files)
    for p in files:
        if total <= MAX_TOTAL:
            break
        size = p.stat().st_size
        p.unlink()
        total -= size


def append_event(root: Path, event: dict, now: datetime | None = None) -> None:
    now = now or datetime.now(timezone.utc)
    retention(root, now)
    prefix = f"events-{now:%Y%m%d}-"
    index = 0
    data = (json.dumps(event, separators=(",", ":"), ensure_ascii=True) + "\n").encode("ascii")
    while True:
        path = root / f"{prefix}{index:03}.jsonl"
        if not path.exists() or path.stat().st_size + len(data) <= MAX_FILE:
            break
        index += 1
    with path.open("ab") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())


def handle_hook(root: Path, payload: object) -> bool:
    # Consent and event write under same lock: pause, revoke and delete cannot race it.
    with locked(root):
        config = read_config(root)
        event = event_from_payload(config, payload)
        if event is None:
            return False
        append_event(root, event)
        return True


def get_events(root: Path) -> list[dict]:
    events = []
    for path in event_files(root):
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                try:
                    obj = json.loads(line)
                    if (isinstance(obj, dict) and obj.get("schemaVersion") == 1
                            and obj.get("eventType") in EVENTS.values()):
                        events.append(obj)
                except (ValueError, UnicodeError):
                    pass
    return events


def change_project(root: Path, project: Path, enable: bool) -> None:
    # Revocation must work even when the original project directory is gone.
    resolved = safe_project(project) if enable else os.path.normcase(str(project.resolve(strict=False)))
    with locked(root):
        config = read_config(root)
        projects = [p for p in config["projects"] if p.get("path") != resolved]
        if enable:
            projects.append({"path": resolved, "id": uuid.uuid4().hex})
            if not config.get("secret"):
                config["secret"] = secrets.token_hex(32)
        config["projects"] = projects
        atomic_json(root / "consent.json", config)


def set_paused(root: Path, pause: bool) -> None:
    with locked(root):
        cfg = read_config(root)
        # resume with zero approved workspaces has no observable effect; prevent it.
        if not pause and not cfg["projects"]:
            raise ValueError("Enable at least one workspace first")
        cfg["paused"] = pause
        atomic_json(root / "consent.json", cfg)


def delete_events(root: Path) -> int:
    with locked(root):
        files = event_files(root)
        for p in files:
            p.unlink()
        return len(files)


def summary(root: Path) -> dict:
    with locked(root):
        cfg = read_config(root)
        events = get_events(root)
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    current = [e for e in events if e.get("timestamp", "").startswith(today)]
    return {"state": "paused" if cfg["paused"] else "recording",
            "projects": len(cfg["projects"]), "eventsTodayUTC": len(current),
            "sessionsTodayUTC": len({e["sessionPseudonym"] for e in current if e["eventType"] == "session_started"}),
            "categoriesTodayUTC": {c: sum(e.get("toolCategory") == c for e in current)
                                    for c in ("file_edit", "shell", "test_build", "inspect", "git", "other")}}


def patterns(root: Path) -> dict:
    """Derived, local aggregate only: no prompts, source files, or commands."""
    from collections import Counter
    with locked(root):
        events = get_events(root)
    categories = Counter(e["toolCategory"] for e in events if e.get("eventType") == "tool_used"
                         and e.get("toolCategory") in ("file_edit", "shell", "test_build", "inspect", "git", "other"))
    sessions: dict[tuple[str, str], list[str]] = {}
    for e in events:
        if e.get("eventType") == "tool_used":
            key = (e["projectPseudonym"], e["sessionPseudonym"])
            sessions.setdefault(key, []).append(e.get("toolCategory", "other"))
    transitions: Counter[str] = Counter()
    for values in sessions.values():
        transitions.update(f"{a} → {b}" for a, b in zip(values, values[1:]))
    return {"sessionsObserved": len(sessions),
            "promptsSubmitted": sum(e.get("eventType") == "prompt_submitted" for e in events),
            "turnsFinished": sum(e.get("eventType") == "turn_finished" for e in events),
            "toolCategoryCounts": dict(categories),
            "commonToolTransitions": dict(transitions.most_common(10))}


def _hook_entries(command: str) -> dict:
    return {event: [{"hooks": [{"type": "command", "command": command,
                                 "timeout": 2 if event == "SessionEnd" else 5,
                                 "statusMessage": HOOK_MARKER}]}]
            for event in EVENTS}


def _find_own_entry(group: object, command: str) -> bool:
    if not isinstance(group, dict) or not isinstance(group.get("hooks"), list):
        return False
    return any(isinstance(h, dict) and h.get("command") == command and
               h.get("statusMessage") == HOOK_MARKER for h in group["hooks"])


def setup_hooks(home: Path, command: str, uninstall: bool = False) -> None:
    """Never replace third-party hook handlers; install is idempotent."""
    home.mkdir(parents=True, exist_ok=True)
    path = home / "hooks.json"
    if path.exists():
        cfg = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(cfg, dict) or not isinstance(cfg.get("hooks", {}), dict):
            raise ValueError("Codex hooks config is not a JSON object with hooks")
    else:
        cfg = {"hooks": {}}
    if uninstall and not path.exists():
        return
    hooks = cfg.setdefault("hooks", {})
    entries = _hook_entries(command)
    for event in EVENTS:
        existing = hooks.get(event, [])
        if not isinstance(existing, list):
            raise ValueError("Invalid existing Codex hook groups; no changes written")
        remaining = []
        for group in existing:
            if not isinstance(group, dict) or not isinstance(group.get("hooks"), list):
                remaining.append(group)
                continue
            handlers = [h for h in group["hooks"] if not (
                isinstance(h, dict) and h.get("command") == command and
                h.get("statusMessage") == HOOK_MARKER)]
            if handlers:
                if len(handlers) == len(group["hooks"]):
                    remaining.append(group)
                else:
                    remaining.append({**group, "hooks": handlers})
        if not uninstall:
            remaining += entries[event]
        if remaining:
            hooks[event] = remaining
        else:
            hooks.pop(event, None)
    if path.exists():
        backup = home / f"hooks.json.gcr-backup-{datetime.now(timezone.utc):%Y%m%d%H%M%S}-{uuid.uuid4().hex[:6]}"
        backup.write_bytes(path.read_bytes())
    atomic_json(path, cfg)


def command_for_hooks() -> str:
    # list2cmdline is the native Windows CreateProcess quoting convention.
    return subprocess.list2cmdline([str(Path(sys.executable).resolve()), str(Path(__file__).resolve()), "hook"])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Opt-in local Codex coding activity metadata collector")
    subs = parser.add_subparsers(dest="action", required=True)
    for name in ("install", "uninstall", "status", "pause", "resume", "show-events", "delete-events", "patterns", "hook"):
        subs.add_parser(name)
    for name in ("enable-project", "revoke-project"):
        subs.add_parser(name).add_argument("path", type=Path)
    args = parser.parse_args(argv)
    try:
        root = data_root()
        if args.action == "hook":
            # Hook protocol must be silent, and never affect Codex control flow.
            try:
                if sys.stdin.isatty():
                    return 0
                raw = sys.stdin.buffer.read(MAX_INPUT + 1)
                if len(raw) <= MAX_INPUT:
                    handle_hook(root, json.loads(raw))
            except Exception:
                pass
            return 0
        if args.action in ("install", "uninstall"):
            command = command_for_hooks()
            setup_hooks(codex_home(), command, uninstall=(args.action == "uninstall"))
            print("Uninstalled hook entries; local consent and events remain." if args.action == "uninstall" else
                  "Codex hooks registered. Collection is still OFF until you enable a project and resume. In Codex, run /hooks to review and trust them.")
        elif args.action == "enable-project":
            if not sys.stdin.isatty():
                raise ValueError("Interactive consent is required")
            print("Record only session/tool metadata in this project and its subdirectories; no code or prompts.")
            answer = input("Type ENABLE to explicitly consent: ")
            if answer != "ENABLE":
                print("Not enabled.")
                return 1
            change_project(root, args.path, True)
            print("Workspace approved. Run 'resume' to start recording.")
        elif args.action == "revoke-project":
            change_project(root, args.path, False)
            print("Workspace approval revoked. Existing local events are unchanged; use delete-events to remove them.")
        elif args.action in ("pause", "resume"):
            set_paused(root, args.action == "pause")
            print("Paused." if args.action == "pause" else "Recording for approved workspaces only.")
        elif args.action == "status":
            s = summary(root)
            s["hooksConfigured"] = bool((codex_home() / "hooks.json").is_file() and
                any(_find_own_entry(g, command_for_hooks()) for groups in
                    json.loads((codex_home() / "hooks.json").read_text(encoding="utf-8")).get("hooks", {}).values()
                    if isinstance(groups, list) for g in groups))
            print(json.dumps(s, indent=2))
        elif args.action == "patterns":
            print(json.dumps(patterns(root), indent=2, ensure_ascii=True))
        elif args.action == "show-events":
            with locked(root):
                events = get_events(root)
            for event in events:
                print(json.dumps(event, separators=(",", ":")))
        elif args.action == "delete-events":
            print(f"Deleted {delete_events(root)} local event files.")
        return 0
    except (ValueError, OSError, RuntimeError, json.JSONDecodeError) as e:
        if args.action == "hook":
            return 0
        # Avoid printing untrusted path/JSON contents in errors.
        print(f"Collector error: {type(e).__name__}. Check configuration and permissions.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
