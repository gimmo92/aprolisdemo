"""Deterministic, coordinate-aware spare-parts catalog extractors.

The adapters deliberately have no network or database dependencies.  They
accept a PyMuPDF page and return normalized rows plus a confidence score; the
Vercel handler decides whether a page needs AI review.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any, Iterable, Sequence

import pymupdf as fitz


ITEM_RE = re.compile(r"^\d+(?:[.\-]\d+)*(?:[A-Za-z])?$")
CODE_RE = re.compile(r"^(?=.{4,40}$)(?=.*\d)[A-Z0-9][A-Z0-9._/+()\-]*$", re.I)
QTY_RE = re.compile(r"^\d{1,4}(?:[.,]\d+)?$")
FOOTER_RE = re.compile(r"^\s*\d+\s*/\s*\d+\s*$")
CHARLATTE_ELECTRICAL_RE = re.compile(
    r"^(?P<description>.+?)\s+"
    r"(?P<code>(?=[A-Z0-9._/\-]{6,}\b)(?=[A-Z0-9._/\-]*\d)"
    r"[A-Z][A-Z0-9._/\-]+)\s+"
    r"(?P<quantity>\d{1,4})\s+(?P<item>[A-Za-z0-9_/\-]+)$",
    re.I,
)

NOISE = {
    "ITEM",
    "CODE",
    "QTY",
    "QUANTITY",
    "DESIGNATION",
    "DESCRIPTION",
    "REV",
    "REVIS.",
    "SHEET",
    "DATE",
    "VISA",
    "LIST OF PARTS",
    "PART NUMBER",
}


def clean_text(value: str) -> str:
    return " ".join(value.replace("\u00a0", " ").split()).strip(" \t|")


def normalized(value: str) -> str:
    value = unicodedata.normalize("NFD", value.casefold())
    value = "".join(char for char in value if unicodedata.category(char) != "Mn")
    return re.sub(r"[^a-z0-9]+", " ", value).strip()


def is_noise(value: str) -> bool:
    upper = clean_text(value).upper()
    return (
        not upper
        or upper in NOISE
        or FOOTER_RE.fullmatch(upper) is not None
        or upper.startswith("-- ")
        or "THIS DOCUMENT IS PROPERTY" in upper
    )


def _as_quantity(value: str) -> int | float | None:
    value = value.strip().replace(",", ".")
    if not QTY_RE.fullmatch(value):
        return None
    number = float(value)
    return int(number) if number.is_integer() else number


def _valid_code(value: str) -> bool:
    value = value.strip()
    return CODE_RE.fullmatch(value) is not None and not value.isdigit()


@dataclass(frozen=True)
class TextLine:
    text: str
    words: tuple[tuple[float, float, float, float, str], ...]
    x0: float
    y0: float
    x1: float
    y1: float


def looks_like_parts_page(lines: Sequence[TextLine]) -> bool:
    text = normalized(" ".join(line.text for line in lines))
    header_hits = sum(
        term in text
        for term in (
            "item",
            "position",
            "repere",
            "reference",
            "part number",
            "code",
            "designation",
            "description",
            "quantity",
            "qty",
            "qte",
        )
    )
    code_hits = sum(
        _valid_code(word[4])
        for line in lines
        for word in line.words
    )
    return header_hits >= 2 or code_hits >= 2


@dataclass
class ExtractedPart:
    code: str
    description: str
    original_description: str
    quantity: int | float | None
    item: str
    page: int
    category: str
    assembly_code: str = ""
    assembly_title: str = ""
    source_type: str = "parts"
    confidence: float = 0.7
    bbox: tuple[float, float, float, float] | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.code = clean_text(self.code).upper()
        self.description = clean_text(self.description) or "Descrizione non disponibile"
        self.original_description = (
            clean_text(self.original_description) or self.description
        )
        self.item = clean_text(self.item)
        self.category = clean_text(self.category) or "Ricambi"
        self.confidence = max(0.0, min(1.0, float(self.confidence)))

    @property
    def search_text(self) -> str:
        return normalized(
            " ".join(
                filter(
                    None,
                    (
                        self.code,
                        self.item,
                        self.description,
                        self.original_description,
                        self.category,
                        self.assembly_code,
                        self.assembly_title,
                    ),
                )
            )
        )


@dataclass
class PageExtraction:
    parts: list[ExtractedPart]
    confidence: float
    text_characters: int
    adapter: str
    reasons: list[str] = field(default_factory=list)


def page_lines(page: fitz.Page) -> list[TextLine]:
    """Return PDF lines while preserving word coordinates."""
    words_with_coordinates: list[tuple[float, float, float, float, str]] = []
    for word in page.get_text("words", sort=True):
        if len(word) < 8:
            continue
        x0, y0, x1, y1, text = word[:5]
        text = clean_text(str(text))
        if text:
            words_with_coordinates.append(
                (float(x0), float(y0), float(x1), float(y1), text)
            )

    # Table cells are frequently separate PDF blocks. Group geometrically so
    # headers and rows remain intact even when the producer emitted one text
    # object per cell.
    groups: list[list[tuple[float, float, float, float, str]]] = []
    for word in sorted(
        words_with_coordinates, key=lambda item: ((item[1] + item[3]) / 2, item[0])
    ):
        center = (word[1] + word[3]) / 2
        if groups:
            previous_center = sum(
                (item[1] + item[3]) / 2 for item in groups[-1]
            ) / len(groups[-1])
            tolerance = max(2.5, (word[3] - word[1]) * 0.30)
            if abs(center - previous_center) <= tolerance:
                groups[-1].append(word)
                continue
        groups.append([word])

    lines: list[TextLine] = []
    for words in groups:
        words.sort(key=lambda item: item[0])
        text = clean_text(" ".join(word[4] for word in words))
        if not text:
            continue
        lines.append(
            TextLine(
                text=text,
                words=tuple(words),
                x0=min(word[0] for word in words),
                y0=min(word[1] for word in words),
                x1=max(word[2] for word in words),
                y1=max(word[3] for word in words),
            )
        )
    return sorted(lines, key=lambda line: (round(line.y0, 1), line.x0))


def _deduplicate(parts: Iterable[ExtractedPart]) -> list[ExtractedPart]:
    unique: dict[tuple[str, str, int], ExtractedPart] = {}
    for part in parts:
        key = (part.code.casefold(), part.item.casefold(), part.page)
        previous = unique.get(key)
        if previous is None or part.confidence > previous.confidence:
            unique[key] = part
    return sorted(unique.values(), key=lambda row: (row.page, row.item, row.code))


class BaseAdapter:
    name = "generic"
    header_aliases: dict[str, tuple[str, ...]] = {
        "item": ("item", "position", "pos", "figure no", "rif", "ref"),
        "code": (
            "part number",
            "part no",
            "part nr",
            "codice",
            "code",
            "article",
        ),
        "description": (
            "description",
            "designation",
            "descrizione",
            "denomination",
        ),
        "quantity": ("quantity", "qty", "q ty", "qta", "quantita", "anzahl"),
    }

    def extract_page(self, page: fitz.Page, page_number: int) -> PageExtraction:
        lines = page_lines(page)
        text_chars = sum(len(line.text) for line in lines)
        parts = self.parse_coordinate_tables(lines, page_number)
        parts.extend(self.parse_line_patterns(lines, page_number))
        parts = _deduplicate(parts)
        confidence = (
            sum(part.confidence for part in parts) / len(parts) if parts else 0.0
        )
        reasons: list[str] = []
        if text_chars < 80:
            reasons.append("insufficient_text")
        if not parts and text_chars >= 80:
            reasons.append("no_rows")
            if looks_like_parts_page(lines):
                reasons.append("unparsed_table")
        if len(parts) == 1:
            reasons.append("sparse_table")
        if parts and confidence < 0.68:
            reasons.append("low_confidence")
        return PageExtraction(parts, confidence, text_chars, self.name, reasons)

    def category_for(self, lines: Sequence[TextLine], header_index: int) -> str:
        for line in reversed(lines[max(0, header_index - 6) : header_index]):
            value = clean_text(line.text)
            if (
                len(value) >= 4
                and len(value) <= 100
                and not is_noise(value)
                and not _valid_code(value)
            ):
                return value
        return "Ricambi"

    def _find_header(
        self, lines: Sequence[TextLine]
    ) -> tuple[int, dict[str, float]] | None:
        for index, line in enumerate(lines):
            anchors: dict[str, float] = {}
            word_tokens = [normalized(word[4]) for word in line.words]
            for column, aliases in self.header_aliases.items():
                for alias in sorted(
                    aliases, key=lambda value: len(normalized(value).split()), reverse=True
                ):
                    alias_tokens = normalized(alias).split()
                    width = len(alias_tokens)
                    for start in range(len(word_tokens) - width + 1):
                        if word_tokens[start : start + width] == alias_tokens:
                            anchors[column] = line.words[start][0]
                            break
                    if column in anchors:
                        break
            if "code" in anchors and "description" in anchors:
                return index, anchors
        return None

    @staticmethod
    def _cells(line: TextLine, anchors: dict[str, float]) -> dict[str, str]:
        ordered = sorted(anchors.items(), key=lambda item: item[1])
        cells: dict[str, list[str]] = {column: [] for column in anchors}
        for word in line.words:
            center = (word[0] + word[2]) / 2
            candidates = [item for item in ordered if item[1] <= center + 4]
            column = (candidates[-1] if candidates else ordered[0])[0]
            cells[column].append(word[4])
        return {column: clean_text(" ".join(values)) for column, values in cells.items()}

    def parse_coordinate_tables(
        self, lines: Sequence[TextLine], page_number: int
    ) -> list[ExtractedPart]:
        found = self._find_header(lines)
        if not found:
            return []
        header_index, anchors = found
        category = self.category_for(lines, header_index)
        parts: list[ExtractedPart] = []

        for line in lines[header_index + 1 :]:
            if line.y0 <= lines[header_index].y0 + 2:
                continue
            cells = self._cells(line, anchors)
            code = clean_text(cells.get("code", "")).strip(".,;:")
            description = clean_text(cells.get("description", ""))
            item = clean_text(cells.get("item", ""))
            quantity = _as_quantity(cells.get("quantity", ""))

            # Wrapped descriptions are common in illustrated-parts tables.
            if not _valid_code(code):
                if parts and description and not item:
                    parts[-1].description = clean_text(
                        f"{parts[-1].description} {description}"
                    )
                    parts[-1].original_description = parts[-1].description
                continue
            if not description or normalized(description) in {
                "description",
                "designation",
                "descrizione",
            }:
                continue

            confidence = 0.70
            confidence += 0.08 if item else 0
            confidence += 0.08 if quantity is not None else 0
            confidence += 0.06 if len(description) >= 4 else 0
            parts.append(
                ExtractedPart(
                    code=code,
                    description=description,
                    original_description=description,
                    quantity=quantity,
                    item=item,
                    page=page_number,
                    category=category,
                    source_type="coordinate_table",
                    confidence=confidence,
                    bbox=(line.x0, line.y0, line.x1, line.y1),
                )
            )
        return parts

    def line_regexes(self) -> tuple[re.Pattern[str], ...]:
        return (
            re.compile(
                r"^(?P<item>\d+(?:[.\-]\d+)*)\s+"
                r"(?P<code>(?=\S{4,40}\s)(?=\S*\d)\S+)\s+"
                r"(?P<description>.+?)\s+(?P<quantity>\d{1,4})$",
                re.I,
            ),
            re.compile(
                r"^(?P<code>(?=\S{5,40}\s)(?=\S*\d)\S+)\s+"
                r"(?P<description>[A-Za-zÀ-ÿ].+?)\s+"
                r"(?P<quantity>\d{1,4})$",
                re.I,
            ),
        )

    def parse_line_patterns(
        self, lines: Sequence[TextLine], page_number: int
    ) -> list[ExtractedPart]:
        parts: list[ExtractedPart] = []
        category = self.category_for(lines, len(lines))
        for line in lines:
            for pattern in self.line_regexes():
                match = pattern.fullmatch(line.text)
                if not match:
                    continue
                values = match.groupdict()
                code = values["code"].strip(".,;:")
                if not _valid_code(code):
                    continue
                parts.append(
                    ExtractedPart(
                        code=code,
                        description=values["description"],
                        original_description=values["description"],
                        quantity=_as_quantity(values.get("quantity", "")),
                        item=values.get("item", ""),
                        page=page_number,
                        category=category,
                        source_type="line_pattern",
                        confidence=0.65,
                        bbox=(line.x0, line.y0, line.x1, line.y1),
                    )
                )
                break
        return parts


class CharlatteAdapter(BaseAdapter):
    """Charlatte full manuals and standalone chapter-5 documents."""

    name = "charlatte"

    @staticmethod
    def _assembly(lines: Sequence[TextLine]) -> tuple[str, str]:
        useful = [line.text for line in lines if not is_noise(line.text)]
        for index, line in enumerate(useful[:28]):
            match = re.search(r"\b([A-Z][A-Z0-9._/\-]{5,})\s+(?:REV|Rev)", line)
            if match and any(char.isdigit() for char in match.group(1)):
                return match.group(1), clean_text(line[: match.start()]).strip(". ")
            if _valid_code(line) and index:
                title = clean_text(useful[index - 1]).strip(". ")
                if re.search(r"[A-Za-zÀ-ÿ]{3}", title):
                    return line, title
        return "", ""

    @staticmethod
    def _split_description(values: Sequence[str]) -> tuple[str, str]:
        useful = [clean_text(value) for value in values if not is_noise(value)]
        if not useful:
            return "Descrizione non disponibile", ""
        if len(useful) == 1:
            return useful[0], useful[0]
        midpoint = max(1, len(useful) // 2)
        french = clean_text(" ".join(useful[:midpoint]))
        english = clean_text(" ".join(useful[midpoint:]))
        return english or french, french

    def _sequential_rows(
        self, lines: Sequence[TextLine], page_number: int
    ) -> list[ExtractedPart]:
        useful = [line for line in lines if not is_noise(line.text)]
        assembly_code, assembly_title = self._assembly(useful)
        starts = [
            index
            for index in range(len(useful) - 2)
            if ITEM_RE.fullmatch(useful[index].text)
            and _valid_code(useful[index + 1].text)
            and QTY_RE.fullmatch(useful[index + 2].text)
        ]
        parts: list[ExtractedPart] = []
        for position, start in enumerate(starts):
            end = starts[position + 1] if position + 1 < len(starts) else len(useful)
            item, code, quantity = (useful[start + offset].text for offset in range(3))
            description, original = self._split_description(
                [line.text for line in useful[start + 3 : min(end, start + 12)]]
            )
            row_lines = useful[start : min(end, start + 12)]
            parts.append(
                ExtractedPart(
                    code=code,
                    description=description,
                    original_description=original,
                    quantity=_as_quantity(quantity),
                    item=item,
                    page=page_number,
                    category=assembly_title or "Ricambi meccanici",
                    assembly_code=assembly_code,
                    assembly_title=assembly_title,
                    source_type="mechanical",
                    confidence=0.94 if description != "Descrizione non disponibile" else 0.78,
                    bbox=(
                        min(line.x0 for line in row_lines),
                        min(line.y0 for line in row_lines),
                        max(line.x1 for line in row_lines),
                        max(line.y1 for line in row_lines),
                    ),
                )
            )
        return parts

    def _electrical_rows(
        self, lines: Sequence[TextLine], page_number: int
    ) -> list[ExtractedPart]:
        parts: list[ExtractedPart] = []
        for line in lines:
            match = CHARLATTE_ELECTRICAL_RE.fullmatch(line.text)
            if not match:
                continue
            code = match.group("code")
            if not _valid_code(code):
                continue
            description = clean_text(match.group("description").replace("_", " "))
            parts.append(
                ExtractedPart(
                    code=code,
                    description=description,
                    original_description=description,
                    quantity=_as_quantity(match.group("quantity")),
                    item=match.group("item"),
                    page=page_number,
                    category="Impianto elettrico",
                    source_type="electrical",
                    confidence=0.90,
                    bbox=(line.x0, line.y0, line.x1, line.y1),
                )
            )
        return parts

    def extract_page(self, page: fitz.Page, page_number: int) -> PageExtraction:
        lines = page_lines(page)
        text_chars = sum(len(line.text) for line in lines)
        parts = self._sequential_rows(lines, page_number)
        parts.extend(self._electrical_rows(lines, page_number))
        if not parts:
            parts.extend(self.parse_coordinate_tables(lines, page_number))
        parts = _deduplicate(parts)
        confidence = (
            sum(part.confidence for part in parts) / len(parts) if parts else 0.0
        )
        reasons: list[str] = []
        if text_chars < 80:
            reasons.append("insufficient_text")
        if not parts and text_chars >= 80:
            reasons.append("no_rows")
            if looks_like_parts_page(lines):
                reasons.append("unparsed_table")
        if len(parts) == 1:
            reasons.append("sparse_table")
        if parts and confidence < 0.72:
            reasons.append("low_confidence")
        return PageExtraction(parts, confidence, text_chars, self.name, reasons)


class HangchaAdapter(BaseAdapter):
    name = "hangcha"
    header_aliases = {
        **BaseAdapter.header_aliases,
        "item": ("fig no", "figure no", "item no", "item", "no"),
        "code": ("part number", "part no", "part code", "material code"),
        "quantity": ("quantity", "qty", "q ty"),
    }


class MovexxAdapter(BaseAdapter):
    """Movexx option/spare price lists: card layout with CODE + 'Item no.' + description."""

    name = "movexx"
    header_aliases = {
        **BaseAdapter.header_aliases,
        "item": ("position", "pos", "item", "item no"),
        "code": ("part nr", "part no", "article nr", "artikelnummer", "code"),
        "description": ("description", "omschrijving", "bezeichnung"),
        "quantity": ("qty", "quantity", "aantal", "anzahl"),
    }

    _CODE_RE = re.compile(r"^(?=.{3,40}$)[A-Z0-9][A-Z0-9._/+()\-]*$", re.I)
    _ITEM_LABEL_RE = re.compile(r"^item\s*no\.?$", re.I)

    @classmethod
    def _valid_movexx_code(cls, value: str) -> bool:
        value = clean_text(value).replace(" ", "")
        return (
            cls._CODE_RE.fullmatch(value) is not None
            and any(char.isdigit() for char in value)
        )

    def _parse_item_cards(
        self, page: fitz.Page, page_number: int
    ) -> list[ExtractedPart]:
        parts: list[ExtractedPart] = []
        for block in page.get_text("dict").get("blocks", []):
            if block.get("type") != 0:
                continue
            lines = [
                clean_text(
                    "".join(span.get("text", "") for span in line.get("spans", []))
                )
                for line in block.get("lines", [])
            ]
            lines = [line for line in lines if line]
            if len(lines) < 3:
                continue
            label_index = next(
                (
                    index
                    for index, line in enumerate(lines)
                    if self._ITEM_LABEL_RE.fullmatch(line)
                ),
                None,
            )
            if label_index is None or label_index < 1:
                continue
            code = clean_text(lines[label_index - 1]).replace(" ", "")
            if not self._valid_movexx_code(code):
                continue
            description = clean_text(" ".join(lines[label_index + 1 :]))
            if not description or is_noise(description):
                continue
            if "movexx international" in description.casefold():
                continue
            bbox = (
                float(block.get("bbox", [0, 0, 0, 0])[0]),
                float(block.get("bbox", [0, 0, 0, 0])[1]),
                float(block.get("bbox", [0, 0, 0, 0])[2]),
                float(block.get("bbox", [0, 0, 0, 0])[3]),
            )
            parts.append(
                ExtractedPart(
                    code=code,
                    description=description,
                    original_description=description,
                    quantity=1,
                    item="",
                    page=page_number,
                    category="Ricambi / opzioni",
                    source_type="mechanical",
                    confidence=0.92,
                    bbox=bbox,
                    metadata={"layout": "movexx_item_card"},
                )
            )
        return parts

    def extract_page(self, page: fitz.Page, page_number: int) -> PageExtraction:
        lines = page_lines(page)
        text_chars = sum(len(line.text) for line in lines)
        parts = self._parse_item_cards(page, page_number)
        if not parts:
            parts.extend(self.parse_coordinate_tables(lines, page_number))
            parts.extend(self.parse_line_patterns(lines, page_number))
        parts = _deduplicate(parts)
        confidence = (
            sum(part.confidence for part in parts) / len(parts) if parts else 0.0
        )
        reasons: list[str] = []
        if text_chars < 40:
            reasons.append("insufficient_text")
        if not parts and text_chars >= 40:
            reasons.append("no_rows")
            if any(
                self._ITEM_LABEL_RE.fullmatch(line.text) for line in lines
            ) or looks_like_parts_page(lines):
                reasons.append("unparsed_table")
        if len(parts) == 1:
            reasons.append("sparse_table")
        if parts and confidence < 0.68:
            reasons.append("low_confidence")
        return PageExtraction(parts, confidence, text_chars, self.name, reasons)


class FiorentiniAdapter(BaseAdapter):
    name = "fiorentini"
    header_aliases = {
        **BaseAdapter.header_aliases,
        "item": ("pos", "posizione", "rif", "item"),
        "code": ("codice", "code", "part number"),
        "description": ("descrizione", "description", "denominazione"),
        "quantity": ("qta", "quantita", "qty"),
    }


class GenericAdapter(BaseAdapter):
    name = "generic"


def select_adapter(brand: str | None, document_name: str | None = None) -> BaseAdapter:
    value = normalized(f"{brand or ''} {document_name or ''}")
    if "charlatte" in value:
        return CharlatteAdapter()
    if "hangcha" in value:
        return HangchaAdapter()
    if "movexx" in value:
        return MovexxAdapter()
    if "fiorentini" in value:
        return FiorentiniAdapter()
    return GenericAdapter()


__all__ = [
    "BaseAdapter",
    "CharlatteAdapter",
    "ExtractedPart",
    "FiorentiniAdapter",
    "GenericAdapter",
    "HangchaAdapter",
    "MovexxAdapter",
    "PageExtraction",
    "clean_text",
    "normalized",
    "page_lines",
    "select_adapter",
]
