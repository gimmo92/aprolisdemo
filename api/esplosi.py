"""Interactive exploded-view API: page image + clickable item hotspots."""

from __future__ import annotations

import base64
import json
import os
import re
from http.server import BaseHTTPRequestHandler
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, urlencode, urlparse
from urllib.request import Request, urlopen
from uuid import UUID

import pymupdf as fitz

ITEM_TOKEN_RE = re.compile(r"^\d+(?:[.\-]\d+)*(?:[A-Za-z])?$")
MAX_PDF_BYTES = 80 * 1024 * 1024


class EsplosiError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message

    def payload(self) -> dict[str, Any]:
        return {"error": self.message, "code": self.code}


def _env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise EsplosiError(503, "INVALID_CONFIGURATION", f"{name} non configurato.")
    return value


def _supabase_headers(service_key: str) -> dict[str, str]:
    return {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
    }


def _rest_select(
    url: str,
    service_key: str,
    table: str,
    query: dict[str, str],
) -> list[dict[str, Any]]:
    path = f"{url}/rest/v1/{quote(table, safe='')}?{urlencode(query)}"
    request = Request(
        path,
        headers={
            **_supabase_headers(service_key),
            "Accept": "application/json",
            "Accept-Profile": "public",
        },
        method="GET",
    )
    try:
        with urlopen(request, timeout=45) as response:
            data = json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        raise EsplosiError(
            502,
            "SUPABASE_ERROR",
            f"Lettura {table} non riuscita.",
        ) from error
    except (URLError, TimeoutError, json.JSONDecodeError) as error:
        raise EsplosiError(
            502,
            "SUPABASE_UNAVAILABLE",
            "Supabase non raggiungibile.",
        ) from error
    if not isinstance(data, list):
        raise EsplosiError(502, "SUPABASE_INVALID_RESPONSE", "Risposta non valida.")
    return [row for row in data if isinstance(row, dict)]


def _download_pdf(url: str, service_key: str, bucket: str, storage_path: str) -> bytes:
    if (
        not storage_path
        or storage_path.startswith("/")
        or any(part in {"", ".", ".."} for part in storage_path.split("/"))
    ):
        raise EsplosiError(422, "INVALID_STORAGE_PATH", "Percorso PDF non valido.")
    object_path = (
        f"{url}/storage/v1/object/authenticated/{quote(bucket, safe='')}/"
        f"{quote(storage_path, safe='/')}"
    )
    request = Request(
        object_path,
        headers={
            **_supabase_headers(service_key),
            "Accept": "application/pdf,application/octet-stream",
        },
        method="GET",
    )
    try:
        with urlopen(request, timeout=90) as response:
            chunks: list[bytes] = []
            size = 0
            while chunk := response.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_PDF_BYTES:
                    raise EsplosiError(413, "PDF_TOO_LARGE", "PDF troppo grande.")
                chunks.append(chunk)
            return b"".join(chunks)
    except EsplosiError:
        raise
    except HTTPError as error:
        raise EsplosiError(
            404 if error.code == 404 else 502,
            "PDF_DOWNLOAD_FAILED",
            "Impossibile scaricare il PDF del catalogo.",
        ) from error
    except (URLError, TimeoutError) as error:
        raise EsplosiError(
            502,
            "PDF_DOWNLOAD_FAILED",
            "Download PDF non riuscito.",
        ) from error


def _normalize_item(value: str) -> str:
    return value.strip().upper()


def _extract_hotspots(
    page: fitz.Page,
    items: set[str],
) -> list[dict[str, Any]]:
    """Map BOM item numbers to clickable dots on the drawing area."""
    if not items:
        return []
    rect = page.rect
    width = max(rect.width, 1.0)
    height = max(rect.height, 1.0)
    words = page.get_text("words") or []

    # Prefer matches outside dense table bands (usually lower page).
    scored: dict[str, tuple[float, float, float, float, float]] = {}
    for word in words:
        if len(word) < 5:
            continue
        x0, y0, x1, y1, text = word[:5]
        token = _normalize_item(str(text))
        if token not in items and not ITEM_TOKEN_RE.fullmatch(token):
            continue
        # Charlatte tables often repeat item numbers; keep drawing-side hits.
        matched = token if token in items else ""
        if not matched:
            continue
        cx = ((float(x0) + float(x1)) / 2) / width
        cy = ((float(y0) + float(y1)) / 2) / height
        score = 0.0
        if cy < 0.68:
            score += 3.0
        if cx < 0.62:
            score += 2.0
        # Prefer compact callout tokens.
        score += max(0.0, 2.5 - abs(float(x1) - float(x0)) / 40.0)
        previous = scored.get(matched)
        if previous is None or score > previous[0]:
            scored[matched] = (score, cx, cy, float(x0) / width, float(y0) / height)

    hotspots = [
        {
            "item": item,
            "x": round(cx, 4),
            "y": round(cy, 4),
            "labelX": round(x0, 4),
            "labelY": round(y0, 4),
        }
        for item, (_score, cx, cy, x0, y0) in scored.items()
    ]
    return sorted(hotspots, key=lambda row: (row["y"], row["x"], row["item"]))


def _fallback_hotspots(items: list[str]) -> list[dict[str, Any]]:
    """Place numbered dots when PDF text callouts are not extractable."""
    if not items:
        return []
    columns = 2 if len(items) > 8 else 1
    hotspots: list[dict[str, Any]] = []
    for index, item in enumerate(items):
        column = index % columns
        row = index // columns
        rows = max(1, (len(items) + columns - 1) // columns)
        hotspots.append(
            {
                "item": item,
                "x": round(0.08 + column * 0.12, 4),
                "y": round(0.12 + (row + 0.5) * (0.76 / rows), 4),
                "labelX": round(0.05 + column * 0.12, 4),
                "labelY": round(0.10 + row * (0.76 / rows), 4),
                "synthetic": True,
            }
        )
    return hotspots


def _render_page_png(page: fitz.Page, scale: float = 1.6) -> bytes:
    pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
    return pixmap.tobytes("png")


def build_esploso(catalog_id: str, page_number: int) -> dict[str, Any]:
    try:
        UUID(catalog_id)
    except ValueError as error:
        raise EsplosiError(400, "INVALID_CATALOG", "Catalogo non valido.") from error
    if page_number < 1:
        raise EsplosiError(400, "INVALID_PAGE", "Pagina non valida.")

    url = _env("SUPABASE_URL").rstrip("/")
    service_key = _env("SUPABASE_SERVICE_ROLE_KEY")
    bucket = os.environ.get("SUPABASE_CATALOG_BUCKET", "catalogs").strip() or "catalogs"

    catalogs = _rest_select(
        url,
        service_key,
        "catalogs",
        {
            "id": f"eq.{catalog_id}",
            "status": "eq.ready",
            "select": "id,brand,model,version,original_filename,storage_path,page_count,part_count",
            "limit": "1",
        },
    )
    if not catalogs:
        raise EsplosiError(404, "CATALOG_NOT_FOUND", "Catalogo non trovato o non pronto.")
    catalog = catalogs[0]
    storage_path = str(catalog.get("storage_path") or "")
    if not storage_path:
        raise EsplosiError(404, "PDF_NOT_AVAILABLE", "PDF non disponibile per questo catalogo.")

    part_rows = _rest_select(
        url,
        service_key,
        "parts",
        {
            "catalog_id": f"eq.{catalog_id}",
            "page_number": f"eq.{page_number}",
            "select": (
                "code,description,original_description,quantity,item,page_number,"
                "category,assembly_code,assembly_title,source_type"
            ),
            "order": "item.asc",
        },
    )
    parts: list[dict[str, Any]] = []
    for row in part_rows:
        part: dict[str, Any] = {
            "code": str(row.get("code") or ""),
            "description": str(
                row.get("description") or row.get("original_description") or "Ricambio"
            ),
            "originalDescription": str(
                row.get("original_description") or row.get("description") or "Ricambio"
            ),
            "quantity": row.get("quantity") if row.get("quantity") is not None else 0,
            "item": str(row.get("item") or ""),
            "page": page_number,
            "category": str(row.get("category") or "Ricambi"),
            "sourceType": (
                row.get("source_type")
                if row.get("source_type") in {"mechanical", "electrical", "generic"}
                else "generic"
            ),
        }
        assembly_code = str(row.get("assembly_code") or "").strip()
        assembly_title = str(row.get("assembly_title") or "").strip()
        if assembly_code:
            part["assemblyCode"] = assembly_code
        if assembly_title:
            part["assemblyTitle"] = assembly_title
        parts.append(part)

    if not parts:
        raise EsplosiError(
            404,
            "PAGE_WITHOUT_PARTS",
            "Nessun ricambio indicizzato su questa pagina.",
        )

    pdf_bytes = _download_pdf(url, service_key, bucket, storage_path)
    try:
        document = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception as error:
        raise EsplosiError(422, "INVALID_PDF", "PDF non leggibile.") from error

    try:
        if page_number > document.page_count:
            raise EsplosiError(
                404,
                "PAGE_NOT_FOUND",
                f"Il PDF ha solo {document.page_count} pagine.",
            )
        page = document[page_number - 1]
        items = {
            _normalize_item(part["item"])
            for part in parts
            if part["item"] and ITEM_TOKEN_RE.fullmatch(_normalize_item(part["item"]))
        }
        hotspots = _extract_hotspots(page, items)
        if len(hotspots) < max(1, len(items) // 3):
            # Too few callouts found in text layer — use synthetic legend dots.
            ordered_items = sorted(items, key=lambda value: (len(value), value))
            hotspots = _fallback_hotspots(ordered_items)
        png = _render_page_png(page)
    finally:
        document.close()

    assembly_title = next(
        (part.get("assemblyTitle") for part in parts if part.get("assemblyTitle")),
        "",
    )
    assembly_code = next(
        (part.get("assemblyCode") for part in parts if part.get("assemblyCode")),
        "",
    )

    return {
        "catalog": {
            "id": catalog["id"],
            "brand": catalog.get("brand") or "",
            "model": catalog.get("model") or "",
            "version": catalog.get("version") or "",
            "documentName": catalog.get("original_filename") or "",
            "documentPages": catalog.get("page_count") or 0,
            "partCount": catalog.get("part_count") or 0,
            "pdfAvailable": True,
        },
        "page": page_number,
        "assemblyTitle": assembly_title or f"Pagina {page_number}",
        "assemblyCode": assembly_code or "",
        "image": f"data:image/png;base64,{base64.b64encode(png).decode('ascii')}",
        "hotspots": hotspots,
        "parts": parts,
    }


class handler(BaseHTTPRequestHandler):
    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode(
            "utf-8"
        )
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "private, max-age=60")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(encoded)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self) -> None:
        try:
            query = parse_qs(urlparse(self.path).query)
            catalog_id = (query.get("catalogId") or query.get("catalog_id") or [""])[0]
            page_raw = (query.get("page") or ["1"])[0]
            try:
                page_number = int(page_raw)
            except ValueError as error:
                raise EsplosiError(400, "INVALID_PAGE", "Pagina non valida.") from error
            payload = build_esploso(catalog_id, page_number)
            self._send_json(200, payload)
        except EsplosiError as error:
            self._send_json(error.status, error.payload())
        except Exception as error:
            self._send_json(
                500,
                {
                    "error": "Errore interno durante il caricamento dell'esploso.",
                    "code": "ESPLOSI_INTERNAL_ERROR",
                    "type": type(error).__name__,
                },
            )

    def log_message(self, format: str, *args: Any) -> None:
        return
