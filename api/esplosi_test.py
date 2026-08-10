import pymupdf as fitz
from esplosi import _extract_hotspots, _fallback_hotspots, _normalize_item


def test_extract_hotspots_prefers_drawing_area() -> None:
    document = fitz.open()
    page = document.new_page(width=600, height=800)
    # Drawing-area callouts
    page.insert_text((80, 120), "1", fontsize=14)
    page.insert_text((140, 180), "2", fontsize=14)
    # Dense table-like zone near bottom
    page.insert_text((80, 700), "1", fontsize=10)
    page.insert_text((200, 700), "CODE", fontsize=10)
    hotspots = _extract_hotspots(page, {"1", "2"})
    document.close()
    assert {spot["item"] for spot in hotspots} == {"1", "2"}
    one = next(spot for spot in hotspots if spot["item"] == "1")
    assert one["y"] < 0.5


def test_fallback_hotspots_cover_all_items() -> None:
    spots = _fallback_hotspots(["1", "2", "10"])
    assert [spot["item"] for spot in spots] == ["1", "2", "10"]
    assert all(0 < spot["x"] < 1 and 0 < spot["y"] < 1 for spot in spots)


def test_normalize_item() -> None:
    assert _normalize_item(" 12a ") == "12A"
