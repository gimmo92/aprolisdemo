from adapters import FiorentiniAdapter, TextLine, looks_like_parts_page, select_adapter


def _line(text: str, y: float = 10.0) -> TextLine:
    words = tuple(
        (index * 40.0, y, index * 40.0 + 30.0, y + 10.0, word)
        for index, word in enumerate(text.split())
    )
    return TextLine(text=text, words=words, x0=0.0, y0=y, x1=220.0, y1=y + 10.0)


def test_italian_headers_look_like_parts_page() -> None:
    lines = [
        _line("Pos Codice Descrizione Qta"),
        _line("1 AB1234 Cuscinetto anteriore 2"),
    ]
    assert looks_like_parts_page(lines)


def test_selects_fiorentini_adapter_from_brand() -> None:
    adapter = select_adapter("Fiorentini", "TX060_Movincar.pdf")
    assert adapter.name == "fiorentini"


def test_fiorentini_line_pattern_without_trailing_qty() -> None:
    adapter = FiorentiniAdapter()
    parts = adapter.parse_line_patterns(
        [_line("12 TX0600456 Guarnizione sportello")],
        4,
    )
    assert len(parts) == 1
    assert parts[0].code == "TX0600456"
    assert parts[0].item == "12"
