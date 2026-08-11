import sys
import unittest
from pathlib import Path

import pymupdf

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "api"))

from indexing.exploded import (  # noqa: E402
    _extract_callouts,
    _word_callouts,
    sanitize_svg,
)


class ExplodedExtractionTests(unittest.TestCase):
    def test_multiple_item_label_is_split_and_line_tip_is_traced(self):
        document = pymupdf.open()
        page = document.new_page(width=300, height=220)
        page.insert_text((60, 80), "4,5", fontsize=10)
        words = _word_callouts(page, {"4", "5"})
        self.assertEqual(len(words), 1)
        _, items, rect = words[0]
        center = pymupdf.Point((rect.x0 + rect.x1) / 2, (rect.y0 + rect.y1) / 2)
        page.draw_line(
            pymupdf.Point(center.x + 6, center.y),
            pymupdf.Point(center.x + 38, center.y + 8),
        )
        callouts = _extract_callouts(page, page.rect, words)
        self.assertEqual(callouts[0].items, (4.0, 5.0))
        self.assertTrue(callouts[0].traced)
        self.assertNotEqual(callouts[0].tip_x, callouts[0].x)
        document.close()

    def test_svg_sanitizer_removes_code_external_links_and_static_text(self):
        unsafe = """
        <svg xmlns="http://www.w3.org/2000/svg">
          <script>alert(1)</script>
          <foreignObject><div>bad</div></foreignObject>
          <text x="12.3456">12</text>
          <path onclick="bad()" d="M 1.2345 2.3456 L 3.4567 4.5678"/>
          <image href="https://example.com/a.png"/>
        </svg>
        """
        safe = sanitize_svg(unsafe)
        self.assertNotIn("script", safe)
        self.assertNotIn("foreignObject", safe)
        self.assertNotIn("<text", safe)
        self.assertNotIn("onclick", safe)
        self.assertNotIn("https://example.com", safe)
        self.assertIn("1.23", safe)


if __name__ == "__main__":
    unittest.main()
