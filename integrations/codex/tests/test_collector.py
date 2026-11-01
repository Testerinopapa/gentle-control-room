"""Run with python -m unittest discover -s integrations/codex/tests -v."""
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import collector as c


class CollectorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'local'
        self.project = Path(self.tmp.name) / 'approved'
        self.other = Path(self.tmp.name) / 'other'
        self.project.mkdir()
        self.other.mkdir()
        self.raw = {
            'hook_event_name': 'PostToolUse', 'cwd': str(self.project), 'session_id': 'private-id-123',
            'tool_name': 'apply_patch', 'tool_input': {'command': 'SECRET=sk-123 edit users/password.txt'},
            'tool_response': {'stdout': 'password is abc'}, 'transcript_path': 'C:/private/transcript.jsonl',
            'prompt': 'tell me my credentials', 'model': 'gpt-secret',
        }

    def approve(self):
        c.change_project(self.root, self.project, True)
        c.set_paused(self.root, False)

    def test_clean_install_does_not_capture(self):
        self.assertFalse(c.handle_hook(self.root, self.raw))
        self.assertEqual(c.get_events(self.root), [])

    def test_consent_remains_paused_until_explicit_resume(self):
        c.change_project(self.root, self.project, True)
        self.assertFalse(c.handle_hook(self.root, self.raw))
        c.set_paused(self.root, False)
        self.assertTrue(c.handle_hook(self.root, self.raw))

    def test_workspace_isolation(self):
        self.approve()
        other = dict(self.raw, cwd=str(self.other))
        self.assertFalse(c.handle_hook(self.root, other))
        self.assertTrue(c.handle_hook(self.root, self.raw))
        self.assertEqual(len(c.get_events(self.root)), 1)

    def test_subdirectory_is_allowed_and_prefix_is_not(self):
        child = self.project / 'src'
        child.mkdir()
        misleading = Path(str(self.project) + '-other')
        misleading.mkdir()
        self.approve()
        self.assertTrue(c.handle_hook(self.root, dict(self.raw, cwd=str(child))))
        self.assertFalse(c.handle_hook(self.root, dict(self.raw, cwd=str(misleading))))

    def test_sanitization_even_if_secret_in_tool_name(self):
        self.approve()
        c.handle_hook(self.root, self.raw)
        c.handle_hook(self.root, dict(self.raw, tool_name='mcp__secret_sk-private'))
        saved = json.dumps(c.get_events(self.root))
        for secret in ['private-id-123', 'sk-123', 'password', 'abc', 'transcript', 'users/', 'mcp__secret', str(self.project), 'gpt-secret']:
            self.assertNotIn(secret, saved)
        self.assertEqual(c.get_events(self.root)[0]['toolCategory'], 'file_edit')
        self.assertEqual(c.get_events(self.root)[1]['toolCategory'], 'other')
        self.assertEqual(set(c.get_events(self.root)[0]),
                         {'schemaVersion', 'timestamp', 'eventType', 'sessionPseudonym', 'projectPseudonym', 'toolCategory'})

    def test_session_id_pseudonym_is_stable_and_project_id_random(self):
        self.approve()
        c.handle_hook(self.root, self.raw)
        c.handle_hook(self.root, dict(self.raw, hook_event_name='Stop'))
        events = c.get_events(self.root)
        self.assertEqual(events[0]['sessionPseudonym'], events[1]['sessionPseudonym'])
        self.assertNotEqual(events[0]['sessionPseudonym'], 'private-id-123')
        self.assertEqual(events[0]['projectPseudonym'], events[1]['projectPseudonym'])

    def test_pause_revoke_delete_and_resume(self):
        self.approve()
        self.assertTrue(c.handle_hook(self.root, self.raw))
        c.set_paused(self.root, True)
        self.assertFalse(c.handle_hook(self.root, self.raw))
        c.set_paused(self.root, False)
        c.change_project(self.root, self.project, False)
        self.assertFalse(c.handle_hook(self.root, self.raw))
        self.assertEqual(c.delete_events(self.root), 1)
        self.assertEqual(c.get_events(self.root), [])

    def test_aggregated_patterns_do_not_leak_sensitive_data(self):
        self.approve()
        c.handle_hook(self.root, self.raw)
        c.handle_hook(self.root, dict(self.raw, tool_name='Bash'))
        p = c.patterns(self.root)
        self.assertEqual(p['commonToolTransitions'], {'file_edit → shell': 1})
        self.assertEqual(p['toolCategoryCounts'], {'file_edit': 1, 'shell': 1})
        self.assertNotIn('password', json.dumps(p))
        self.assertNotIn(str(self.project), json.dumps(p))

    def test_invalid_events_or_missing_session_fail_closed(self):
        self.approve()
        for invalid in [None, [], {}, dict(self.raw, hook_event_name='PreToolUse'),
                        dict(self.raw, session_id=''), dict(self.raw, cwd=None),
                        dict(self.raw, cwd=str(self.other)), dict(self.raw, session_id=0)]:
            self.assertFalse(c.handle_hook(self.root, invalid))
        self.assertEqual(c.get_events(self.root), [])

    def test_rotation_and_retention(self):
        self.approve()
        now = datetime.now(timezone.utc)
        with c.locked(self.root):
            old = self.root / f'events-{now - timedelta(days=45):%Y%m%d}-000.jsonl'
            old.write_text('{}\n', encoding='utf8')
            c.append_event(self.root, c.event_from_payload(c.read_config(self.root), self.raw, now), now)
        self.assertFalse(old.exists())
        self.assertEqual(len(c.get_events(self.root)), 1)

    def test_malformed_lines_skipped(self):
        self.root.mkdir(parents=True)
        now = datetime.now(timezone.utc)
        (self.root / f'events-{now:%Y%m%d}-000.jsonl').write_text('{broken json\n', encoding='utf8')
        self.assertEqual(c.get_events(self.root), [])

    def test_concurrent_writes_are_atomic(self):
        self.approve()
        def worker(_):
            for _ in range(12):
                self.assertTrue(c.handle_hook(self.root, self.raw))
        threads = [threading.Thread(target=worker, args=(i,)) for i in range(4)]
        for t in threads: t.start()
        for t in threads: t.join()
        self.assertEqual(len(c.get_events(self.root)), 48)

    def test_uninstall_preserves_other_hooks_in_same_group(self):
        home = Path(self.tmp.name) / 'codex'
        home.mkdir()
        initial = {'description': 'preserved', 'hooks': {
            'SessionStart': [{'hooks': [{'type': 'command', 'command': 'echo keep'}]}],
            'Stop': [{'hooks': [{'type': 'command', 'command': 'echo stay'}]}]}}
        (home / 'hooks.json').write_text(json.dumps(initial), encoding='utf8')
        command = 'python collector.py hook'
        c.setup_hooks(home, command)
        once = json.loads((home / 'hooks.json').read_text())
        self.assertEqual(len(once['hooks']['SessionStart']), 2)
        c.setup_hooks(home, command)
        twice = json.loads((home / 'hooks.json').read_text())
        self.assertEqual(len(twice['hooks']['SessionStart']), 2)
        # Another handler may later be added to our own matcher group.
        twice['hooks']['SessionStart'][-1]['hooks'].append({'type': 'command', 'command': 'echo extra'})
        (home / 'hooks.json').write_text(json.dumps(twice), encoding='utf8')
        c.setup_hooks(home, command, uninstall=True)
        final = json.loads((home / 'hooks.json').read_text())
        self.assertEqual(final['description'], 'preserved')
        self.assertEqual(final['hooks']['SessionStart'], [
            {'hooks': [{'type': 'command', 'command': 'echo keep'}]},
            {'hooks': [{'type': 'command', 'command': 'echo extra'}]}])
        self.assertEqual(final['hooks']['Stop'], [{'hooks': [{'type': 'command', 'command': 'echo stay'}]}])

    def test_cli_enable_requires_interactive_confirmation(self):
        with patch.object(c, 'data_root', return_value=self.root), patch.object(sys.stdin, 'isatty', return_value=False):
            self.assertEqual(c.main(['enable-project', str(self.project)]), 1)
        self.assertFalse((self.root / 'consent.json').exists())

    def test_hook_cli_silently_ignores_invalid_json(self):
        import io
        fake_stdin = type('FakeInput', (), {'buffer': io.BytesIO(b'{invalid-json'),
                                            'isatty': lambda self: False})()
        with patch.object(c, 'data_root', return_value=self.root), patch.object(sys, 'stdin', fake_stdin):
            self.assertEqual(c.main(['hook']), 0)
        self.assertEqual(c.get_events(self.root), [])

    def test_resume_requires_selected_workspace(self):
        with self.assertRaises(ValueError):
            c.set_paused(self.root, False)

    def test_revocation_possible_after_deleting_folder(self):
        self.approve()
        self.project.rmdir()
        c.change_project(self.root, self.project, False)
        self.assertEqual(c.read_config(self.root)['projects'], [])


if __name__ == '__main__':
    unittest.main()
