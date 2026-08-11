"""One-time exploded-view extraction from catalog PDFs.

The browser must never parse the source PDF. This module turns drawing pages
into sanitized assets plus persisted callout geometry during ingestion.
"""

from __future__ import annotations

import gzip
import html
import math
import re
import uuid
from dataclasses import dataclass
from typing import Any, Iterable
from xml.etree import ElementTree

import pymupdf as fitz


CALLOUT_RE = re.compile(
    r"^\d{1,3}(?:\.\d{1,3})?(?:,\d{1,3}(?:\.\d{1,3})?)*$"
)
FORBIDDEN_TAGS = {"script", "foreignObject"}
EXTERNAL_LINK_RE = re.compile(r"^(?:https?:)?//", re.I)
NUMBER_RE = re.compile(r"-?\d+(?:\.\d+)?")
TRACE_THRESHOLD = 0.8


@dataclass(frozen=True)
class ExtractedCallout:
    label: str
    items: tuple[float, ...]
    x: float
    y: float
    tip_x: float
    tip_y: float
    traced: bool


@dataclass(frozen=True)
class ExplodedAsset:
    view_id: str
    machine: str
    figure_code: str
    title: str
    page_index: int
    parts_pages: tuple[int, ...]
    asset_type: str
    extension: str
    content_type: str
    content_encoding: str | None
    content: bytes
    view_w: float
    view_h: float
    trace_rate: float
    callouts: tuple[ExtractedCallout, ...]
    expected_items: int


def _normalized_item(value: Any) -> str:
    text = str(value or "").strip().replace(" ", "")
    if not text:
        return ""
    try:
        number = float(text.replace(",", "."))
    except ValueError:
        return text.upper()
    return f"{number:g}"


def _label_items(label: str) -> tuple[float, ...]:
    values: list[float] = []
    for token in label.split(","):
        try:
            values.append(float(token))
        except ValueError:
            continue
    return tuple(values)


def _word_callouts(
    page: fitz.Page, expected: set[str]
) -> list[tuple[str, tuple[float, ...], fitz.Rect]]:
    result: list[tuple[str, tuple[float, ...], fitz.Rect]] = []
    for word in page.get_text("words", sort=False) or []:
        if len(word) < 5:
            continue
        label = str(word[4]).strip()
        if not CALLOUT_RE.fullmatch(label):
            continue
        items = _label_items(label)
        if not items or not any(_normalized_item(item) in expected for item in items):
            continue
        result.append((label, items, fitz.Rect(*map(float, word[:4]))))
    return result


def _drawing_score(
    page: fitz.Page,
    expected: set[str],
    figure_code: str,
    title: str,
) -> float:
    callouts = _word_callouts(page, expected)
    if not callouts:
        return -1.0
    unique = {
        _normalized_item(item)
        for _, items, _ in callouts
        for item in items
        if _normalized_item(item) in expected
    }
    width = max(page.rect.width, 1.0)
    x_bands = {
        round((((rect.x0 + rect.x1) / 2) / width) * 20)
        for _, _, rect in callouts
    }
    duplicate_count = max(0, len(callouts) - len(unique))
    page_text = page.get_text("text").upper()
    identity_bonus = 0.0
    if figure_code and figure_code.upper() in page_text:
        identity_bonus += 30.0
    title_tokens = [token for token in re.findall(r"[A-Z0-9]{3,}", title.upper())]
    if title_tokens and sum(token in page_text for token in title_tokens) >= max(
        1, len(title_tokens) // 2
    ):
        identity_bonus += 20.0
    return (
        len(unique) * 5.0
        + len(x_bands) * 12.0
        - duplicate_count * 2.0
        + identity_bonus
    )


def _select_drawing_page(
    document: fitz.Document,
    parts_pages: Iterable[int],
    expected: set[str],
    figure_code: str,
    title: str,
) -> fitz.Page:
    pages = sorted(set(parts_pages))
    first = pages[0]
    candidates = range(max(1, first - 3), min(document.page_count, pages[-1]) + 1)
    scored = [
        (
            _drawing_score(document[number - 1], expected, figure_code, title),
            -abs(first - number),
            number,
        )
        for number in candidates
    ]
    _, _, selected = max(scored)
    return document[selected - 1]


def _percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round((len(ordered) - 1) * fraction)))
    return ordered[index]


def _drawing_clip(
    page: fitz.Page,
    callout_words: list[tuple[str, tuple[float, ...], fitz.Rect]],
) -> fitz.Rect:
    page_rect = page.rect
    drawings = page.get_drawings() or []
    rects: list[fitz.Rect] = []
    callout_y = [
        (rect.y0 + rect.y1) / 2 for _, _, rect in callout_words
    ]
    if callout_y:
        vertical_min = max(page_rect.y0, min(callout_y) - page_rect.height * 0.28)
        vertical_max = min(page_rect.y1, max(callout_y) + page_rect.height * 0.14)
    else:
        vertical_min = page_rect.y0
        vertical_max = page_rect.y1

    for drawing in drawings:
        rect = fitz.Rect(drawing.get("rect", fitz.Rect()))
        if rect.is_empty or rect.is_infinite:
            continue
        if rect.width >= page_rect.width * 0.94 or rect.height >= page_rect.height * 0.94:
            continue
        center = (rect.y0 + rect.y1) / 2
        if vertical_min <= center <= vertical_max:
            rects.append(rect)

    if not rects:
        return fitz.Rect(page_rect)

    x0 = _percentile([rect.x0 for rect in rects], 0.01)
    y0 = _percentile([rect.y0 for rect in rects], 0.01)
    x1 = _percentile([rect.x1 for rect in rects], 0.99)
    y1 = _percentile([rect.y1 for rect in rects], 0.99)
    for _, _, rect in callout_words:
        x0, y0 = min(x0, rect.x0), min(y0, rect.y0)
        x1, y1 = max(x1, rect.x1), max(y1, rect.y1)
    clip = fitz.Rect(x0 - 2, y0 - 2, x1 + 2, y1 + 2) & page_rect
    return clip if not clip.is_empty else fitz.Rect(page_rect)


def _line_segments(page: fitz.Page) -> list[tuple[fitz.Point, fitz.Point]]:
    segments: list[tuple[fitz.Point, fitz.Point]] = []
    for drawing in page.get_drawings() or []:
        for item in drawing.get("items", []):
            if item and item[0] == "l" and len(item) >= 3:
                segments.append((fitz.Point(item[1]), fitz.Point(item[2])))
    return segments


def _extract_callouts(
    page: fitz.Page,
    clip: fitz.Rect,
    words: list[tuple[str, tuple[float, ...], fitz.Rect]],
) -> tuple[ExtractedCallout, ...]:
    segments = _line_segments(page)
    result: list[ExtractedCallout] = []
    for label, items, rect in words:
        center = fitz.Point((rect.x0 + rect.x1) / 2, (rect.y0 + rect.y1) / 2)
        if not clip.contains(center):
            continue
        best: tuple[float, fitz.Point] | None = None
        for a, b in segments:
            for near, far in ((a, b), (b, a)):
                distance = math.hypot(near.x - center.x, near.y - center.y)
                length = math.hypot(far.x - near.x, far.y - near.y)
                if (
                    distance < 13
                    and 4 < length < 60
                    and (best is None or length > best[0])
                ):
                    best = (length, far)
        tip = best[1] if best else center
        result.append(
            ExtractedCallout(
                label=label,
                items=items,
                x=round(center.x - clip.x0, 2),
                y=round(center.y - clip.y0, 2),
                tip_x=round(tip.x - clip.x0, 2),
                tip_y=round(tip.y - clip.y0, 2),
                traced=best is not None,
            )
        )
    return tuple(result)


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def sanitize_svg(svg: str) -> str:
    """Remove executable/external content and static text from an extracted SVG."""
    ElementTree.register_namespace("", "http://www.w3.org/2000/svg")
    ElementTree.register_namespace("xlink", "http://www.w3.org/1999/xlink")
    root = ElementTree.fromstring(svg)
    for parent in list(root.iter()):
        for child in list(parent):
            if _local_name(child.tag) in FORBIDDEN_TAGS | {"text"}:
                parent.remove(child)
        for name, value in list(parent.attrib.items()):
            local = _local_name(name).lower()
            if local.startswith("on"):
                del parent.attrib[name]
            elif local in {"href", "src"} and EXTERNAL_LINK_RE.match(value.strip()):
                del parent.attrib[name]
            elif local in {"d", "points", "x", "y", "width", "height", "viewbox"}:
                parent.attrib[name] = NUMBER_RE.sub(
                    lambda match: f"{float(match.group()):.2f}".rstrip("0").rstrip("."),
                    value,
                )
    serialized = ElementTree.tostring(root, encoding="unicode")
    return re.sub(r">\s+<", "><", serialized).strip()


def _svg_asset(page: fitz.Page, clip: fitz.Rect) -> bytes:
    original = fitz.Rect(page.cropbox)
    try:
        page.set_cropbox(clip)
        svg = page.get_svg_image(matrix=fitz.Identity, text_as_path=False)
    finally:
        page.set_cropbox(original)
    return gzip.compress(sanitize_svg(svg).encode("utf-8"), compresslevel=9)


def _png_asset(page: fitz.Page, clip: fitz.Rect) -> bytes:
    pixmap = page.get_pixmap(
        matrix=fitz.Matrix(1.6, 1.6),
        clip=clip,
        alpha=False,
    )
    return pixmap.tobytes("png")


def _group_parts(parts: Iterable[Any]) -> list[dict[str, Any]]:
    groups: dict[tuple[str, str], dict[str, Any]] = {}
    for part in parts:
        item = _normalized_item(getattr(part, "item", ""))
        if not item or not re.fullmatch(r"\d+(?:\.\d+)?", item):
            continue
        title = str(getattr(part, "assembly_title", "") or "").strip()
        code = str(getattr(part, "assembly_code", "") or "").strip()
        if not code and not title:
            continue
        figure_code = code or re.sub(r"[^A-Z0-9]+", "-", title.upper()).strip("-")
        key = (figure_code.casefold(), title.casefold())
        group = groups.setdefault(
            key,
            {
                "figure_code": figure_code,
                "title": title or figure_code,
                "pages": set(),
                "items": set(),
                "parts": set(),
            },
        )
        group["pages"].add(int(getattr(part, "page", 0)))
        group["items"].add(item)
        group["parts"].add((item, str(getattr(part, "code", ""))))
    return list(groups.values())


def extract_exploded_assets(
    document: fitz.Document,
    parts: Iterable[Any],
    *,
    catalog_id: str,
    machine: str,
) -> list[ExplodedAsset]:
    assets: list[ExplodedAsset] = []
    for group in _group_parts(parts):
        pages = tuple(
            page
            for page in sorted(group["pages"])
            if 1 <= page <= document.page_count
        )
        if not pages:
            continue
        expected = set(group["items"])
        page = _select_drawing_page(
            document,
            pages,
            expected,
            group["figure_code"],
            group["title"],
        )
        words = _word_callouts(page, expected)
        clip = _drawing_clip(page, words)
        callouts = _extract_callouts(page, clip, words)
        trace_rate = (
            sum(callout.traced for callout in callouts) / len(callouts)
            if callouts
            else 0.0
        )
        drawings = page.get_drawings() or []
        vector = sum(len(drawing.get("items", [])) for drawing in drawings) >= 40
        interactive = vector and trace_rate >= TRACE_THRESHOLD
        asset_type = "svg" if interactive else "png"
        content = _svg_asset(page, clip) if interactive else _png_asset(page, clip)
        view_id = str(
            uuid.uuid5(
                uuid.NAMESPACE_URL,
                f"aprolis:{catalog_id}:{group['figure_code'].casefold()}",
            )
        )
        assets.append(
            ExplodedAsset(
                view_id=view_id,
                machine=machine,
                figure_code=group["figure_code"],
                title=group["title"],
                page_index=page.number + 1,
                parts_pages=pages,
                asset_type=asset_type,
                extension="svg.gz" if interactive else "png",
                content_type="image/svg+xml" if interactive else "image/png",
                content_encoding="gzip" if interactive else None,
                content=content,
                view_w=round(clip.width, 2),
                view_h=round(clip.height, 2),
                trace_rate=round(trace_rate, 4),
                callouts=callouts,
                expected_items=len(expected),
            )
        )
    return assets


def asset_rows(
    assets: Iterable[ExplodedAsset],
    *,
    catalog_id: str,
    checksum: str,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    views: list[dict[str, Any]] = []
    callouts: list[dict[str, Any]] = []
    uploads: list[dict[str, Any]] = []
    for asset in assets:
        path = (
            f"{catalog_id}/{checksum[:16]}/{asset.view_id}.{asset.extension}"
        )
        views.append(
            {
                "id": asset.view_id,
                "machine": asset.machine,
                "figure_code": asset.figure_code,
                "title": asset.title,
                "page_index": asset.page_index,
                "parts_pages": list(asset.parts_pages),
                "svg_path": path,
                "asset_type": asset.asset_type,
                "view_w": asset.view_w,
                "view_h": asset.view_h,
                "trace_rate": asset.trace_rate,
                "metadata": {
                    "expectedItems": asset.expected_items,
                    "callouts": len(asset.callouts),
                },
            }
        )
        uploads.append(
            {
                "path": path,
                "content": asset.content,
                "content_type": asset.content_type,
                "content_encoding": asset.content_encoding,
            }
        )
        for index, callout in enumerate(asset.callouts):
            callouts.append(
                {
                    "id": str(
                        uuid.uuid5(
                            uuid.UUID(asset.view_id),
                            f"{index}:{callout.label}:{callout.x}:{callout.y}",
                        )
                    ),
                    "view_id": asset.view_id,
                    "label": html.unescape(callout.label),
                    "items": list(callout.items),
                    "x": callout.x,
                    "y": callout.y,
                    "tip_x": callout.tip_x,
                    "tip_y": callout.tip_y,
                    "traced": callout.traced,
                }
            )
    return views, callouts, uploads
