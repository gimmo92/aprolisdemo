import unittest
from pathlib import Path

import pymupdf as fitz

from api.indexing.adapters import MovexxAdapter, select_adapter


PDF = (
    Path(__file__).resolve().parents[1]
    / "Cataloghi ricambi"
    / "Brand"
    / "Movexx"
    / "mopl-tt1000-f-en-2025-01-option-price-list_677bea408c613.pdf"
)


class MovexxAdapterTests(unittest.TestCase):
    def test_selects_movexx_adapter(self):
        adapter = select_adapter(
            "Movexx",
            "mopl-tt1000-f-en-2025-01-option-price-list_677bea408c613.pdf",
        )
        self.assertIsInstance(adapter, MovexxAdapter)

    @unittest.skipUnless(PDF.exists(), "Movexx sample PDF not present")
    def test_extracts_item_cards(self):
        document = fitz.open(PDF)
        adapter = MovexxAdapter()
        parts = []
        for index in range(document.page_count):
            parts.extend(adapter.extract_page(document[index], index + 1).parts)
        codes = {part.code for part in parts}
        self.assertGreaterEqual(len(parts), 40)
        self.assertIn("336783", codes)
        self.assertIn("OPT0013", codes)
        self.assertTrue(any(code.startswith("M0121") for code in codes))


if __name__ == "__main__":
    unittest.main()
