#!/usr/bin/env python3
"""User-invoked process recorder. Never launched automatically by the observer.
Usage: python record-result.py --repository C:\work\repo --kind test -- dotnet test
No command text, output, environment or source code is persisted.
"""
import argparse
import base64
import ctypes
from ctypes import wintypes
from datetime import datetime, timezone
import hashlib
import hmac
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid


def unprotect(data):
    class Blob(ctypes.Structure):
        _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_ubyte))]
    buffer = (ctypes.c_ubyte * len(data)).from_buffer_copy(data)
    source, output = Blob(len(data), buffer), Blob()
    crypt = ctypes.WinDLL("crypt32", use_last_error=True)
    crypt.CryptUnprotectData.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    crypt.CryptUnprotectData.restype = wintypes.BOOL
    if not crypt.CryptUnprotectData(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(output)):
        raise RuntimeError("Local consent could not be decrypted.")
    try:
        return ctypes.string_at(output.data, output.size)
    finally:
        ctypes.memset(output.data, 0, output.size)
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.LocalFree.argtypes = [ctypes.c_void_p]
        kernel.LocalFree(output.data)


def safe_path(path):
    for p in [path, *path.parents]:
        if p.exists() and (p.is_symlink() or getattr(p.lstat(), "st_file_attributes", 0) & 0x400):
            raise RuntimeError("Linked paths are not supported.")


def consent(root, repository):
    safe_path(root)
    state = json.loads((root / "work-v1.json").read_text(encoding="utf-8"))
    if state.get("Protection") != "CurrentUserDPAPI":
        raise RuntimeError("Open the current Windows app and approve tracking first.")
    state = json.loads(unprotect(base64.b64decode(state["Data"])))
    if not state.get("LocalEnabled"):
        raise RuntimeError("Local analysis is disabled.")
    matches = [r for r in state.get("Repositories", []) if os.path.normcase(r["Root"]) == os.path.normcase(str(repository))
               and r.get("Approved") and not r.get("Paused")]
    if len(matches) != 1:
        raise RuntimeError("Approve and resume this repository first.")
    return matches[0]


def run(repository, kind, command, root):
    safe_path(repository)
    approved = consent(root, repository)
    started = datetime.now(timezone.utc).isoformat()
    # Only the command explicitly supplied by the user is run. No shell expansion.
    process = subprocess.run(command, cwd=repository, shell=False, check=False)
    current = consent(root, repository)
    if current["Id"] != approved["Id"] or current["ReceiptKey"] != approved["ReceiptKey"]:
        raise RuntimeError("Consent changed during execution; no result was recorded.")
    payload = json.dumps({"RepositoryId": approved["Id"], "StartedAt": started,
                          "FinishedAt": datetime.now(timezone.utc).isoformat(), "Kind": kind,
                          "ExitCode": process.returncode, "HeadBefore": "", "HeadAfter": ""}, separators=(",", ":"))
    receipt = {"Payload": payload, "Signature": hmac.new(base64.b64decode(approved["ReceiptKey"]), payload.encode(), hashlib.sha256).hexdigest()}
    folder = root / "CodeResults"
    folder.mkdir(exist_ok=True)
    safe_path(folder)
    target = folder / (uuid.uuid4().hex + ".json")
    temporary = target.with_suffix(".tmp")
    temporary.write_text(json.dumps(receipt), encoding="utf-8")
    temporary.replace(target)
    # This dedicated receipt directory holds at most 100 bounded records.
    for old in sorted(folder.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)[100:]:
        safe_path(old)
        old.unlink()
    return process.returncode


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--kind", choices=["test", "build"], required=True)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if sys.platform != "win32" or not command:
        parser.error("Windows and an explicitly supplied command after -- are required.")
    repository = Path(os.path.abspath(args.repository))
    root = Path(os.environ["LOCALAPPDATA"]) / "GentleControlRoom" / "CodingWork"
    try:
        return run(repository, args.kind, command, root)
    except Exception:
        print("Result recording failed. Check approval and access; private data was not logged.", file=sys.stderr)
        return 125


if __name__ == "__main__":
    sys.exit(main())
