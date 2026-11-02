import importlib.util
import json
import hashlib
import hmac
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("recorder", Path(__file__).parents[1] / "record-result.py")
recorder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recorder)

class RecorderTests(unittest.TestCase):
    def test_exit_and_minimized_authenticated_receipt(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            approved = {"Id": "fixture", "ReceiptKey": "YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY3ODk="}
            with patch.object(recorder, "consent", return_value=approved):
                self.assertEqual(recorder.run(root, "test", [sys.executable, "-c", "import sys; sys.exit(7)"], root), 7)
            item = json.loads(next((root / "CodeResults").glob("*.json")).read_text())
            payload = json.loads(item["Payload"])
            self.assertEqual(payload["ExitCode"], 7)
            self.assertEqual(set(payload), {"RepositoryId", "StartedAt", "FinishedAt", "Kind", "ExitCode", "HeadBefore", "HeadAfter"})
            self.assertNotIn("sys.exit", item["Payload"])
            self.assertEqual(item["Signature"], hmac.new(recorder.base64.b64decode(approved["ReceiptKey"]), item["Payload"].encode(), hashlib.sha256).hexdigest())

    def test_disabled_consent_never_starts_process(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(recorder, "consent", side_effect=RuntimeError()), patch.object(subprocess, "run") as run:
            with self.assertRaises(RuntimeError):
                recorder.run(Path(tmp), "test", ["must-not-run"], Path(tmp))
            run.assert_not_called()

    def test_consent_change_discards_receipt(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(recorder, "consent", side_effect=[{"Id": "a", "ReceiptKey": "before"}, {"Id": "a", "ReceiptKey": "after"}]):
            with self.assertRaises(RuntimeError):
                recorder.run(Path(tmp), "build", [sys.executable, "-c", "pass"], Path(tmp))
            self.assertFalse((Path(tmp) / "CodeResults").exists())

if __name__ == "__main__":
    unittest.main()
