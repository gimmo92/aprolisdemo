"""Extract a deployable spare-parts index from the local Charlatte PDF.

The source PDF is intentionally not committed. Run this script locally whenever
the catalog changes; only the generated JSON index is deployed to Vercel.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from pathlib import Path
from typing import Any

import fitz


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PDF = (
    ROOT
    / "Cataloghi ricambi"
    / "Brand"
    / "Charlatte"
    / "T135"
    / "T135 sn. 10"
    / "T13510073-13510074 AR197350"
    / "t135_movincar_avio_global_services_ar197350_REV00.pdf"
)
DEFAULT_OUTPUT = ROOT / "data" / "catalog-index.json"

ITEM_RE = re.compile(r"^\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)*$")
CODE_RE = re.compile(r"^(?=.{6,}$)(?=.*\d)[A-Z][A-Z0-9._/-]+$")
QTY_RE = re.compile(r"^\d{1,4}$")
FOOTER_RE = re.compile(r"^\d+\s*/\s*\d+$")
ELECTRICAL_ROW_RE = re.compile(
    r"^(?P<description>.+?)\s+"
    r"(?P<code>(?=[A-Z0-9._/-]{6,}\b)(?=[A-Z0-9._/-]*\d)[A-Z][A-Z0-9._/-]+)"
    r"\s+(?P<quantity>\d{1,4})\s+(?P<item>[A-Za-z0-9_/-]+)$"
)

NOISE = {
    "ITEM",
    "CODE",
    "QTY",
    "DESIGNATION",
    "DESCRIPTION",
    "REV",
    "PART NUMBER",
    "LIST OF PARTS",
    "DATE",
    "VISA",
    "REVIS.",
    "SHEET",
}


def clean_line(value: str) -> str:
    return " ".join(value.replace("\u00a0", " ").split()).strip(" \t|")


def normalized(value: str) -> str:
    value = unicodedata.normalize("NFD", value.lower())
    value = "".join(char for char in value if unicodedata.category(char) != "Mn")
    return re.sub(r"[^a-z0-9]+", " ", value).strip()


def is_noise(value: str) -> bool:
    upper = value.upper()
    return (
        not value
        or upper in NOISE
        or FOOTER_RE.fullmatch(value) is not None
        or "CHARLATTE MANUTENTION" in upper
        or "ROUTE DU BOUTOIR" in upper
        or "THIS DOCUMENT IS PROPERTY" in upper
        or upper.startswith("-- ")
    )


def page_lines(page: fitz.Page) -> list[str]:
    return [
        line
        for raw in page.get_text("text").splitlines()
        if (line := clean_line(raw)) and not is_noise(line)
    ]


def row_start(lines: list[str], index: int) -> bool:
    return (
        index + 2 < len(lines)
        and ITEM_RE.fullmatch(lines[index]) is not None
        and CODE_RE.fullmatch(lines[index + 1]) is not None
        and QTY_RE.fullmatch(lines[index + 2]) is not None
    )


def find_assembly(lines: list[str]) -> tuple[str, str]:
    for index, line in enumerate(lines[:24]):
        match = re.search(r"\b([A-Z][A-Z0-9._/-]{5,})\s+(?:REV|Rev)", line)
        if match and any(char.isdigit() for char in match.group(1)):
            title = clean_line(line[: match.start()])
            if re.search(r"[A-Za-zÀ-ÿ]{3}", title):
                return match.group(1), title.strip(". ")
        if CODE_RE.fullmatch(line) and index > 0:
            title = lines[index - 1].strip(". ")
            if re.search(r"[A-Za-zÀ-ÿ]{3}", title):
                return line, title
    return "", ""


def split_description(lines: list[str]) -> tuple[str, str]:
    useful = [line for line in lines if not is_noise(line) and len(line) > 1]
    if not useful:
        return "Descrizione non disponibile", ""
    if len(useful) == 1:
        return useful[0], useful[0]
    midpoint = max(1, len(useful) // 2)
    french = " ".join(useful[:midpoint])
    english = " ".join(useful[midpoint:])
    return english or french, french


def parse_mechanical_page(page: fitz.Page, page_number: int) -> list[dict[str, Any]]:
    lines = page_lines(page)
    assembly_code, assembly_title = find_assembly(lines)
    starts = [index for index in range(len(lines)) if row_start(lines, index)]
    parts: list[dict[str, Any]] = []

    for position, start in enumerate(starts):
        end = starts[position + 1] if position + 1 < len(starts) else len(lines)
        item, code, quantity = lines[start : start + 3]
        description, designation = split_description(lines[start + 3 : min(end, start + 11)])
        search_text = " ".join(
            filter(None, [code, item, description, designation, assembly_title])
        )
        parts.append(
            {
                "code": code,
                "description": description,
                "originalDescription": designation,
                "quantity": int(quantity),
                "item": item,
                "page": page_number,
                "category": assembly_title or "Ricambi meccanici",
                "assemblyCode": assembly_code,
                "assemblyTitle": assembly_title,
                "sourceType": "mechanical",
                "searchText": normalized(search_text),
            }
        )
    return parts


def parse_electrical_page(page: fitz.Page, page_number: int) -> list[dict[str, Any]]:
    parts: list[dict[str, Any]] = []
    for line in page_lines(page):
        match = ELECTRICAL_ROW_RE.fullmatch(line)
        if not match:
            continue
        description = match.group("description").replace("_", " ")
        code = match.group("code")
        item = match.group("item")
        if code.startswith("T0135M") and "LIST OF PARTS" in line:
            continue
        parts.append(
            {
                "code": code,
                "description": description,
                "originalDescription": description,
                "quantity": int(match.group("quantity")),
                "item": item,
                "page": page_number,
                "category": "Impianto elettrico",
                "assemblyCode": "T0135M02750-02",
                "assemblyTitle": "Electrical parts list",
                "sourceType": "electrical",
                "searchText": normalized(f"{code} {item} {description} electrical"),
            }
        )
    return parts


def extract_metadata(document: fitz.Document, source: Path) -> dict[str, Any]:
    cover = document[0].get_text("text")
    serial_match = re.search(
        r"(?:Matricola|Serial(?:\s+number)?)\s*:\s*([0-9 e,-]+)",
        cover,
        re.IGNORECASE,
    )
    serials = re.findall(r"\d{7,}", serial_match.group(1)) if serial_match else []
    if not serials:
        serials = ["13510073", "13510074"]
    ar_match = re.search(r"\bAR\s*:\s*(\d+)", cover, re.IGNORECASE)

    return {
        "id": "charlatte-t135-ar197350",
        "brand": "Charlatte Manutention",
        "model": "T135",
        "version": "T135 PH1 80V",
        "customer": "Movincar / Avio Global Services",
        "orderReference": f"AR {ar_match.group(1)}" if ar_match else "AR 197350",
        "serialNumbers": serials,
        "documentName": source.name,
        "documentPages": document.page_count,
    }


def deduplicate(parts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    unique: dict[tuple[str, str, int, str], dict[str, Any]] = {}
    for part in parts:
        key = (part["code"], part["item"], part["page"], part["sourceType"])
        unique[key] = part
    return sorted(unique.values(), key=lambda row: (row["page"], row["item"], row["code"]))


def build_index(source: Path) -> dict[str, Any]:
    with fitz.open(source) as document:
        catalog = extract_metadata(document, source)
        parts: list[dict[str, Any]] = []

        for page_number in range(297, min(405, document.page_count + 1)):
            parts.extend(parse_mechanical_page(document[page_number - 1], page_number))

        for page_number in range(449, min(462, document.page_count + 1)):
            parts.extend(parse_electrical_page(document[page_number - 1], page_number))

    parts = deduplicate(parts)
    catalog["partCount"] = len(parts)
    catalog["parts"] = parts
    return {"version": 1, "catalogs": [catalog]}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_PDF)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--min-parts", type=int, default=100)
    args = parser.parse_args()

    if not args.source.exists():
        print(f"Catalog not found: {args.source}", file=sys.stderr)
        return 1

    index = build_index(args.source)
    count = index["catalogs"][0]["partCount"]
    if count < args.min_parts:
        print(
            f"Extraction produced only {count} parts; expected at least {args.min_parts}.",
            file=sys.stderr,
        )
        return 2

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(index, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"Indexed {count} parts -> {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
