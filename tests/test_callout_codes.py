import unittest

from api.indexing.adapters import is_callout_code, _valid_code


class CalloutCodeTests(unittest.TestCase):
    def test_rejects_balloon_markers(self):
        for value in ("31", "31.2", "31.9", "12A", "3-1", "1.2.3"):
            with self.subTest(value=value):
                self.assertTrue(is_callout_code(value))
                self.assertFalse(_valid_code(value))

    def test_keeps_real_part_codes(self):
        for value in ("AGRDX000002", "LM2525", "PA2506", "OPT0013", "RFLXX100013"):
            with self.subTest(value=value):
                self.assertFalse(is_callout_code(value))
                self.assertTrue(_valid_code(value))

    def test_keeps_long_numeric_movexx_style(self):
        # Pure digits are rejected by _valid_code, but are not callouts.
        self.assertFalse(is_callout_code("336783"))
        self.assertFalse(_valid_code("336783"))


if __name__ == "__main__":
    unittest.main()
