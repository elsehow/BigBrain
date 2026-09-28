import unittest
from probe import verdict


class FailClosedVerdict(unittest.TestCase):
    stdout = 'FILE_READ BLOCKED\nFILE_WRITE BLOCKED\nFILE_ALLOWED_WRITE ALLOWED \nWEBKIT ["ok","BLOCKED"] error=(null)\n'

    def test_complete_containment(self):
        self.assertTrue(verdict(self.stdout, [[1, "/allowed"]], 1, 2, 0)["passed"])

    def test_server_evidence_overrides_webview_claim(self):
        self.assertFalse(verdict(self.stdout, [[1, "/allowed"], [2, "/forbidden"]], 1, 2, 0)["passed"])

    def test_compile_failure_is_not_success(self):
        self.assertFalse(verdict('FILE_READ BLOCKED\nFILE_WRITE BLOCKED\n', [], 1, 2, 0)["passed"])

    def test_timeout_crash_and_missing_checks_fail(self):
        for status in [-9, 1, 65]:
            self.assertFalse(verdict(self.stdout, [[1, "/allowed"]], 1, 2, status)["passed"])
        self.assertFalse(verdict(self.stdout.replace('FILE_WRITE BLOCKED\n', ''), [[1, "/allowed"]], 1, 2, 0)["passed"])
        self.assertFalse(verdict(self.stdout, [], 1, 2, 0)["passed"])


if __name__ == "__main__":
    unittest.main()
