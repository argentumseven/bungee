import importlib.util
import os
from pathlib import Path
import pty
import select
import signal
import sys
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('host', Path(__file__).resolve().parents[1] / 'scripts/bungee-host.py')
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


class InputTests(unittest.TestCase):
    def terminal(self, function, typed):
        child, fd = pty.fork()
        if child == 0:
            code = f"import importlib.util; s=importlib.util.spec_from_file_location('h',{str(host.HERE / 'bungee-host.py')!r}); h=importlib.util.module_from_spec(s);s.loader.exec_module(h);print('RESULT:'+repr(h.{function}('Prompt: ')))"
            os.execv(sys.executable, [sys.executable, '-c', code])
        result = bytearray()
        try:
            deadline = time.monotonic() + 5
            sent = False
            while time.monotonic() < deadline:
                ready, _, _ = select.select([fd], [], [], .1)
                if not ready: continue
                try: chunk = os.read(fd, 4096)
                except OSError: break
                if not chunk: break
                result.extend(chunk)
                if not sent and b'Prompt: ' in result:
                    os.write(fd, typed + b'\n')
                    sent = True
                if b'RESULT:' in result: break
            self.assertIn(b'RESULT:', result, result.decode(errors='replace'))
            return result.decode(errors='replace')
        finally:
            os.close(fd)
            try: os.kill(child, signal.SIGTERM)
            except ProcessLookupError: pass
            os.waitpid(child, 0)

    def test_terminal_accepts_both_backspace_codes(self):
        self.assertIn("RESULT:'20'", self.terminal('ask', b'12\x08\x7f20'))

    def test_secret_input_handles_both_erase_codes_unicode_and_hides_typing(self):
        output = self.terminal('read_secret', 'abcé'.encode() + b'\x08\x7f' + b'XYZ')
        self.assertIn("RESULT:'abXYZ'", output)
        self.assertNotIn('abc', output)
        self.assertNotIn('é', output)

    def test_invalid_answer_only_repeats_that_field(self):
        answers = ['10000', '8443', '203.0.113.5', '10.10.201.27', '10.10.201.27', '10.10.10.0/24', 'off', 'oops', '20', 'stable', 'yes']
        with patch.object(host, 'ask', side_effect=answers) as ask, patch.object(host,'choose_maps',return_value=[]):
            config = host.guided()
        prompts = [call.args[0] for call in ask.call_args_list]
        self.assertEqual(sum('WireGuard UDP' in p for p in prompts), 1)
        self.assertEqual(sum('storage capacity' in p for p in prompts), 2)
        self.assertEqual(config['storage_size_gib'], 20)
        self.assertEqual(config['web_host'], '10.10.201.27')

    def test_password_confirmation_retries_without_restarting_configuration(self):
        with patch.object(host, 'read_secret', side_effect=['a sufficiently long password', 'mismatch', 'a different long password', 'a different long password']):
            self.assertEqual(host.password_input(), 'a different long password')

    def test_password_validation_preserves_spaces_and_blocks_controls(self):
        password = '  a sufficiently long password  '
        self.assertEqual(host.validate_password(password), password)
        for value in ['short', 'long password with\x08control', 'x' * 1025]:
            with self.assertRaises(ValueError): host.validate_password(value)


if __name__ == '__main__': unittest.main()
