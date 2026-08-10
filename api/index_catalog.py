"""Authenticated Vercel endpoint for multi-brand PDF catalog ingestion."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

import pymupdf as fitz

try:
    from .indexing import ExtractedPart, PageExtraction, select_adapter
except ImportError:  # Allows local loading from inside the api directory.
    from indexing import ExtractedPart, PageExtraction, select_adapter


DEFAULT_MAX_PDF_BYTES = 250 * 1024 * 1024
DEFAULT_BATCH_SIZE = 250
MIN_TEXT_CHARACTERS = 80
MIN_PAGE_CONFIDENCE = 0.68
UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-"
    r"[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.I,
)
AI_CODE_RE = re.compile(r"^(?=.{3,80}$)(?=.*\d)[A-Z0-9][A-Z0-9._/+()\-]*$", re.I)


class IndexingError(Exception):
    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        details: Any | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details

    def payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = {"error": self.message, "code": self.code}
        if self.details is not None:
            payload["details"] = self.details
        return payload


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _stale_running_job(job: dict[str, Any]) -> bool:
    raw = job.get("updated_at")
    if not isinstance(raw, str):
        return False
    try:
        updated_at = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return False
    if updated_at.tzinfo is None:
        updated_at = updated_at.replace(tzinfo=timezone.utc)
    stale_seconds = _env_int("INDEX_STALE_JOB_SECONDS", 360, 300, 3600)
    return (datetime.now(timezone.utc) - updated_at).total_seconds() >= stale_seconds


def _env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = int(raw)
    except ValueError as error:
        raise IndexingError(
            503,
            "INVALID_CONFIGURATION",
            f"{name} deve essere un numero intero.",
        ) from error
    if not minimum <= value <= maximum:
        raise IndexingError(
            503,
            "INVALID_CONFIGURATION",
            f"{name} deve essere compreso tra {minimum} e {maximum}.",
        )
    return value


def _required_environment() -> tuple[str, str]:
    url = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    missing = [
        name
        for name, value in (
            ("SUPABASE_URL", url),
            ("SUPABASE_SERVICE_ROLE_KEY", service_key),
        )
        if not value
    ]
    if missing:
        raise IndexingError(
            503,
            "SUPABASE_NOT_CONFIGURED",
            "Supabase non configurato per l'indicizzazione.",
            {"missing": missing},
        )
    if not url.startswith(("https://", "http://")):
        raise IndexingError(
            503,
            "INVALID_CONFIGURATION",
            "SUPABASE_URL non è un URL valido.",
        )
    return url, service_key


def _decode_json(data: bytes, context: str) -> Any:
    if not data:
        return None
    try:
        return json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise IndexingError(
            502,
            "UPSTREAM_INVALID_JSON",
            f"Risposta JSON non valida da {context}.",
        ) from error


class SupabaseREST:
    def __init__(self, url: str, service_key: str) -> None:
        self.url = url
        self.service_key = service_key
        self.timeout = _env_int("INDEX_HTTP_TIMEOUT_SECONDS", 30, 5, 120)

    def _call(
        self,
        method: str,
        path: str,
        *,
        bearer: str | None = None,
        body: Any | None = None,
        headers: dict[str, str] | None = None,
    ) -> tuple[int, dict[str, str], bytes]:
        request_headers = {
            "Accept": "application/json",
            "apikey": self.service_key,
            "Authorization": f"Bearer {bearer or self.service_key}",
        }
        if headers:
            request_headers.update(headers)
        encoded: bytes | None = None
        if body is not None:
            encoded = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode(
                "utf-8"
            )
            request_headers["Content-Type"] = "application/json"
        request = Request(
            f"{self.url}{path}", data=encoded, headers=request_headers, method=method
        )
        try:
            with urlopen(request, timeout=self.timeout) as response:
                return response.status, dict(response.headers.items()), response.read()
        except HTTPError as error:
            response_body = error.read()
            details: Any
            try:
                details = json.loads(response_body.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                details = {"upstream": response_body[:500].decode("utf-8", "replace")}
            upstream_message = ""
            if isinstance(details, dict):
                upstream_message = next(
                    (
                        str(details[key])
                        for key in ("message", "error", "details", "hint")
                        if isinstance(details.get(key), str) and details[key].strip()
                    ),
                    "",
                )
            raise IndexingError(
                502 if error.code >= 500 else error.code,
                "SUPABASE_REQUEST_FAILED",
                (
                    f"Supabase: {upstream_message}"
                    if upstream_message
                    else "Richiesta Supabase non riuscita."
                ),
                {"status": error.code, "response": details},
            ) from error
        except (URLError, TimeoutError) as error:
            raise IndexingError(
                502,
                "SUPABASE_UNAVAILABLE",
                "Supabase non è raggiungibile.",
                {"reason": str(error.reason) if isinstance(error, URLError) else str(error)},
            ) from error

    def authenticate_admin(self, user_token: str) -> dict[str, Any]:
        try:
            _, _, data = self._call("GET", "/auth/v1/user", bearer=user_token)
        except IndexingError as error:
            if error.status in {401, 403}:
                raise IndexingError(
                    401, "INVALID_SESSION", "Sessione Supabase non valida."
                ) from error
            raise
        user = _decode_json(data, "Supabase Auth")
        user_id = user.get("id") if isinstance(user, dict) else None
        if not isinstance(user_id, str):
            raise IndexingError(401, "INVALID_SESSION", "Sessione Supabase non valida.")

        profiles = self.select("profiles", {"id": f"eq.{user_id}", "select": "*"})
        if not profiles:
            raise IndexingError(
                403,
                "ADMIN_REQUIRED",
                "Profilo amministratore non trovato.",
            )
        profile = profiles[0]
        if profile.get("role") != "admin" and profile.get("is_admin") is not True:
            raise IndexingError(
                403,
                "ADMIN_REQUIRED",
                "Accesso riservato agli amministratori.",
            )
        return user

    def select(self, table: str, query: dict[str, str]) -> list[dict[str, Any]]:
        path = f"/rest/v1/{quote(table, safe='')}?{urlencode(query)}"
        _, _, data = self._call(
            "GET", path, headers={"Accept-Profile": "public"}
        )
        value = _decode_json(data, f"PostgREST/{table}")
        if not isinstance(value, list):
            raise IndexingError(
                502,
                "SUPABASE_INVALID_RESPONSE",
                f"Risposta inattesa per la tabella {table}.",
            )
        return [row for row in value if isinstance(row, dict)]

    def patch(
        self,
        table: str,
        query: dict[str, str],
        values: dict[str, Any],
        *,
        return_rows: bool = False,
    ) -> list[dict[str, Any]]:
        path = f"/rest/v1/{quote(table, safe='')}?{urlencode(query)}"
        prefer = "return=representation" if return_rows else "return=minimal"
        _, _, data = self._call(
            "PATCH",
            path,
            body=values,
            headers={"Content-Profile": "public", "Prefer": prefer},
        )
        if not return_rows:
            return []
        value = _decode_json(data, f"PostgREST/{table}")
        return value if isinstance(value, list) else []

    def delete(self, table: str, query: dict[str, str]) -> None:
        path = f"/rest/v1/{quote(table, safe='')}?{urlencode(query)}"
        self._call(
            "DELETE",
            path,
            headers={"Content-Profile": "public", "Prefer": "return=minimal"},
        )

    def upsert(self, table: str, rows: list[dict[str, Any]]) -> None:
        if not rows:
            return
        query = urlencode({"on_conflict": "id"})
        self._call(
            "POST",
            f"/rest/v1/{quote(table, safe='')}?{query}",
            body=rows,
            headers={
                "Content-Profile": "public",
                "Prefer": "resolution=merge-duplicates,return=minimal",
            },
        )

    def replace_catalog_parts(
        self, catalog_id: str, rows: list[dict[str, Any]]
    ) -> int:
        _, _, data = self._call(
            "POST",
            "/rest/v1/rpc/replace_catalog_parts",
            body={"p_catalog_id": catalog_id, "p_rows": rows},
            headers={
                "Content-Profile": "public",
                "Accept-Profile": "public",
                "Prefer": "return=representation",
            },
        )
        value = _decode_json(data, "PostgREST/replace_catalog_parts")
        if not isinstance(value, int):
            raise IndexingError(
                502,
                "SUPABASE_INVALID_RESPONSE",
                "La sostituzione atomica dei ricambi ha restituito un valore inatteso.",
            )
        return value

    def download_private_object(self, bucket: str, storage_path: str) -> tuple[bytes, str]:
        if (
            not storage_path
            or storage_path.startswith("/")
            or any(part in {"", ".", ".."} for part in storage_path.split("/"))
        ):
            raise IndexingError(
                422,
                "INVALID_STORAGE_PATH",
                "Percorso del PDF nel bucket non valido.",
            )
        maximum = _env_int(
            "INDEX_MAX_PDF_BYTES", DEFAULT_MAX_PDF_BYTES, 1, 250 * 1024 * 1024
        )
        object_path = (
            f"/storage/v1/object/authenticated/{quote(bucket, safe='')}/"
            f"{quote(storage_path, safe='/')}"
        )
        request = Request(
            f"{self.url}{object_path}",
            headers={
                "apikey": self.service_key,
                "Authorization": f"Bearer {self.service_key}",
                "Accept": "application/pdf,application/octet-stream",
            },
            method="GET",
        )
        try:
            with urlopen(request, timeout=self.timeout) as response:
                content_length = response.headers.get("Content-Length")
                if content_length and int(content_length) > maximum:
                    raise IndexingError(
                        413,
                        "PDF_TOO_LARGE",
                        "Il PDF supera la dimensione massima consentita.",
                        {"maximumBytes": maximum},
                    )
                chunks: list[bytes] = []
                size = 0
                while chunk := response.read(1024 * 1024):
                    size += len(chunk)
                    if size > maximum:
                        raise IndexingError(
                            413,
                            "PDF_TOO_LARGE",
                            "Il PDF supera la dimensione massima consentita.",
                            {"maximumBytes": maximum},
                        )
                    chunks.append(chunk)
                mime = response.headers.get("Content-Type", "").split(";", 1)[0].lower()
                return b"".join(chunks), mime
        except IndexingError:
            raise
        except HTTPError as error:
            error.read()
            raise IndexingError(
                502 if error.code >= 500 else error.code,
                "PDF_DOWNLOAD_FAILED",
                "Download del PDF privato non riuscito.",
                {"status": error.code},
            ) from error
        except (URLError, TimeoutError, ValueError) as error:
            raise IndexingError(
                502,
                "PDF_DOWNLOAD_FAILED",
                "Download del PDF privato non riuscito.",
                {"reason": str(error)},
            ) from error


def _catalog_brand(catalog: dict[str, Any]) -> str:
    brand = catalog.get("brand") or catalog.get("manufacturer")
    if isinstance(brand, dict):
        brand = brand.get("name")
    return str(brand or "")


def _catalog_filename(catalog: dict[str, Any]) -> str:
    return str(
        catalog.get("original_filename")
        or catalog.get("filename")
        or catalog.get("document_name")
        or ""
    )


def _clean_metadata_value(value: str, maximum: int = 160) -> str:
    return " ".join(value.replace("\x00", " ").replace("\u00a0", " ").split())[
        :maximum
    ].strip(" \t,;:-")


def _metadata_text(document: fitz.Document) -> str:
    texts: list[str] = []
    # Identification data is normally on the cover or document-control pages.
    for page_index in range(min(document.page_count, 12)):
        text = document[page_index].get_text("text", sort=True)
        if text:
            texts.append(text[:40_000])
    return "\n".join(texts)[:250_000]


def _label_value(text: str, labels: str, maximum: int = 160) -> str:
    match = re.search(
        rf"(?:{labels})\s*(?:[:#]|n[°º.]?)?\s*([^\n\r]{{2,{maximum}}})",
        text,
        re.I,
    )
    return _clean_metadata_value(match.group(1), maximum) if match else ""


def _detect_serials(filename: str, text: str) -> list[str]:
    candidates: list[str] = []
    serial_labels = (
        r"matricol[ae]|serial(?:\s+(?:number|no|nr|n[°º.]))?|"
        r"s\s*[/.-]?\s*n[°º.]?|n[°º.]?\s*(?:di\s+)?serie"
    )
    for match in re.finditer(
        rf"(?:{serial_labels})\s*[:#-]?\s*([^\n\r]{{3,120}})",
        text,
        re.I,
    ):
        value = match.group(1)
        candidates.extend(
            re.findall(r"(?<![A-Z0-9])([A-Z0-9][A-Z0-9._/-]{4,30})(?![A-Z0-9])", value, re.I)
        )

    # Long numeric identifiers in filenames are reliable and cover names such
    # as T13510073-13510074 without requiring catalog-specific configuration.
    candidates.extend(re.findall(r"(?<!\d)(\d{7,14})(?!\d)", filename))

    serials: list[str] = []
    for candidate in candidates:
        for value in re.split(r"[,;/]|\s+-\s+|-(?=\d{6,})", candidate):
            normalized = re.sub(r"[^A-Za-z0-9._/-]", "", value).strip("./_-")
            if (
                5 <= len(normalized) <= 30
                and any(char.isdigit() for char in normalized)
                and normalized.upper() not in {"NUMBER", "SERIAL"}
            ):
                serials.append(normalized.upper())
    return list(dict.fromkeys(serials))[:500]


def _detect_catalog_metadata(
    document: fitz.Document, catalog: dict[str, Any]
) -> dict[str, Any]:
    filename = _catalog_filename(catalog)
    filename_text = re.sub(r"[_-]+", " ", re.sub(r"\.pdf$", "", filename, flags=re.I))
    document_text = _metadata_text(document)
    combined = f"{filename_text}\n{document_text}"

    brand = ""
    for canonical, pattern in (
        ("Charlatte", r"\bcharlatte\b"),
        ("Hangcha", r"\bhangcha\b"),
        ("Movexx", r"\bmovexx\b"),
        ("Fiorentini", r"\bfiorentini\b"),
    ):
        if re.search(pattern, combined, re.I):
            brand = canonical
            break

    labelled_model = _label_value(
        document_text,
        r"model(?:lo|e)?|type|tipo|vehicle\s+type|machine\s+type",
        100,
    )
    model_pattern = (
        r"\b(?:T\d{2,4}|CPD[A-Z0-9-]*\d[A-Z0-9-]*|"
        r"CPCD[A-Z0-9-]*\d[A-Z0-9-]*|CBD[A-Z0-9-]*\d[A-Z0-9-]*|"
        r"XC[A-Z0-9-]*\d[A-Z0-9-]*|FIO[A-Z0-9-]*\d[A-Z0-9-]*)\b"
    )
    filename_model_match = re.search(model_pattern, filename_text, re.I)
    model_match = re.search(model_pattern, combined, re.I)
    labelled_model_match = (
        re.search(
            r"\b[A-Z][A-Z0-9._/-]{1,30}\d[A-Z0-9._/-]*\b",
            labelled_model,
            re.I,
        )
        if labelled_model
        else None
    )
    model = _clean_metadata_value(
        (
            filename_model_match.group(0)
            if filename_model_match
            else (
                model_match.group(0)
                if model_match
                else (
                    labelled_model_match.group(0)
                    if labelled_model_match
                    else labelled_model
                )
            )
        ),
        100,
    ).upper()

    version = ""
    if model:
        for line in document_text.splitlines():
            clean = _clean_metadata_value(line, 100)
            if (
                model.casefold() in clean.casefold()
                and 3 <= len(clean) <= 100
                and re.search(r"\b(?:PH\d+|\d{2,3}\s*V|REV\w*)\b", clean, re.I)
            ):
                version = clean
                break
    version = version or model

    revision_match = re.search(
        r"\b(?:rev(?:ision|isione)?\.?)\s*[:#-]?\s*([A-Z0-9._/-]{1,30})",
        combined,
        re.I,
    )
    revision = revision_match.group(1).upper() if revision_match else ""

    order_match = re.search(
        r"\b(?:AR|order|ordine|commande)\s*[:#-]?\s*([A-Z0-9][A-Z0-9._/-]{3,40})",
        combined,
        re.I,
    )
    order_reference = (
        f"AR {order_match.group(1)}"
        if order_match and order_match.group(0).upper().startswith("AR")
        else (order_match.group(1) if order_match else "")
    )
    if order_reference.upper().startswith("AR AR"):
        order_reference = order_reference[3:]

    customer = _label_value(
        document_text,
        r"customer|client(?:e)?|cliente|utilisateur|destinataire",
        160,
    )
    if not customer and re.search(r"\bmovincar\b", combined, re.I):
        customer = "Movincar / Avio Global Services"

    serial_numbers = _detect_serials(filename, document_text)
    detected = {
        "brand": brand,
        "model": model,
        "version": version,
        "customer": customer,
        "orderReference": _clean_metadata_value(order_reference, 100),
        "revision": _clean_metadata_value(revision, 50),
        "serialNumbers": serial_numbers,
    }
    missing = [
        key
        for key in ("brand", "model", "serialNumbers")
        if not detected.get(key)
    ]
    detected["missing"] = missing
    detected["confidence"] = round(
        sum(
            bool(detected.get(key))
            for key in (
                "brand",
                "model",
                "version",
                "customer",
                "orderReference",
                "revision",
                "serialNumbers",
            )
        )
        / 7,
        3,
    )
    detected["source"] = "deterministic"
    return detected


def _apply_detected_metadata(
    client: SupabaseREST,
    catalog: dict[str, Any],
    detected: dict[str, Any],
) -> None:
    current_metadata = catalog.get("metadata")
    if not isinstance(current_metadata, dict):
        current_metadata = {}
    values = {
        "brand": detected.get("brand") or catalog.get("brand") or "Non rilevato",
        "model": detected.get("model") or catalog.get("model") or "Non rilevato",
        "version": detected.get("version") or None,
        "customer": detected.get("customer") or None,
        "order_reference": detected.get("orderReference") or None,
        "revision": detected.get("revision") or None,
        "metadata": {
            **current_metadata,
            "metadataStatus": (
                "needs_review" if detected.get("missing") else "detected"
            ),
            "detected": detected,
        },
    }
    _catalog_update(client, catalog, values)
    catalog.update(values)

    client.delete("catalog_serials", {"catalog_id": f"eq.{catalog['id']}"})
    rows = [
        {
            "id": str(
                uuid.uuid5(
                    uuid.NAMESPACE_URL,
                    f"{catalog['id']}|serial|{serial.casefold()}",
                )
            ),
            "catalog_id": catalog["id"],
            "serial_number": serial,
            "metadata": {"extraction": "automatic"},
        }
        for serial in detected.get("serialNumbers", [])
    ]
    client.upsert("catalog_serials", rows)


def _validate_pdf(
    content: bytes, downloaded_mime: str, catalog: dict[str, Any]
) -> tuple[str, fitz.Document]:
    if not content:
        raise IndexingError(422, "EMPTY_PDF", "Il file PDF è vuoto.")
    declared_size = catalog.get("file_size")
    if declared_size is None:
        declared_size = catalog.get("file_size_bytes")
    if declared_size is not None:
        try:
            expected_size = int(declared_size)
        except (TypeError, ValueError) as error:
            raise IndexingError(
                422,
                "INVALID_PDF_SIZE",
                "La dimensione registrata del PDF non è valida.",
            ) from error
        if expected_size <= 0:
            raise IndexingError(
                422,
                "INVALID_PDF_SIZE",
                "La dimensione registrata del PDF deve essere positiva.",
            )
        if expected_size != len(content):
            raise IndexingError(
                409,
                "PDF_SIZE_MISMATCH",
                "La dimensione del PDF non corrisponde a quella registrata.",
                {"expected": expected_size, "actual": len(content)},
            )
    declared_mime = str(catalog.get("mime_type") or "application/pdf").lower()
    if declared_mime != "application/pdf":
        raise IndexingError(
            415,
            "INVALID_PDF_MIME",
            "Il catalogo non dichiara un MIME PDF.",
            {"mimeType": declared_mime},
        )
    allowed_download_mimes = {"application/pdf", "application/octet-stream", ""}
    if downloaded_mime not in allowed_download_mimes:
        raise IndexingError(
            415,
            "INVALID_PDF_MIME",
            "Il file scaricato non ha un MIME PDF.",
            {"mimeType": downloaded_mime},
        )
    if content.lstrip()[:5] != b"%PDF-":
        raise IndexingError(
            415,
            "INVALID_PDF_SIGNATURE",
            "Il file scaricato non contiene una firma PDF valida.",
        )

    checksum = hashlib.sha256(content).hexdigest()
    expected = str(catalog.get("checksum_sha256") or "").strip().lower()
    if expected and expected != checksum:
        raise IndexingError(
            409,
            "PDF_CHECKSUM_MISMATCH",
            "Il checksum del PDF non corrisponde a quello registrato.",
            {"expected": expected, "actual": checksum},
        )
    try:
        document = fitz.open(stream=content, filetype="pdf")
    except Exception as error:
        raise IndexingError(
            422, "INVALID_PDF", "PyMuPDF non riesce ad aprire il PDF."
        ) from error
    if document.needs_pass:
        document.close()
        raise IndexingError(
            422, "ENCRYPTED_PDF", "I PDF protetti da password non sono supportati."
        )
    if document.page_count < 1:
        document.close()
        raise IndexingError(422, "EMPTY_PDF", "Il PDF non contiene pagine.")
    return checksum, document


def _page_image(document: fitz.Document, page_index: int) -> bytes:
    page = document[page_index]
    # 144 DPI keeps small table text legible while remaining below Anthropic's
    # image limits for typical A4/A3 catalog pages.
    pixmap = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
    return pixmap.tobytes("png")


def _anthropic_catalog_metadata(
    document: fitz.Document,
    filename: str,
    api_key: str,
    model: str,
) -> dict[str, Any]:
    fields = {
        "brand": {"type": "string", "maxLength": 100},
        "model": {"type": "string", "maxLength": 100},
        "version": {"type": "string", "maxLength": 100},
        "customer": {"type": "string", "maxLength": 160},
        "orderReference": {"type": "string", "maxLength": 100},
        "revision": {"type": "string", "maxLength": 50},
        "serialNumbers": {
            "type": "array",
            "maxItems": 500,
            "items": {"type": "string", "minLength": 3, "maxLength": 50},
        },
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
    }
    page_images = [
        {
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": "image/png",
                "data": base64.b64encode(_page_image(document, page_index)).decode(
                    "ascii"
                ),
            },
        }
        for page_index in range(min(document.page_count, 4))
    ]
    payload = {
        "model": model,
        "max_tokens": 1200,
        "system": (
            "You transcribe catalog identification metadata. Never invent a value. "
            "Use an empty string or empty array when a field is not visible."
        ),
        "messages": [
            {
                "role": "user",
                "content": [
                    *page_images,
                    {
                        "type": "text",
                        "text": (
                            "Extract brand/manufacturer, machine model, full version, "
                            "customer, order or AR reference, document revision and every "
                            f"machine serial number. Filename hint: {filename}"
                        ),
                    },
                ],
            }
        ],
        "tools": [
            {
                "name": "record_catalog_metadata",
                "description": "Record only catalog metadata visible in the PDF.",
                "input_schema": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": fields,
                    "required": list(fields),
                },
            }
        ],
        "tool_choice": {"type": "tool", "name": "record_catalog_metadata"},
    }
    request = Request(
        "https://api.anthropic.com/v1/messages",
        data=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
        },
        method="POST",
    )
    try:
        with urlopen(
            request,
            timeout=_env_int("INDEX_AI_TIMEOUT_SECONDS", 180, 10, 240),
        ) as response:
            message = _decode_json(response.read(), "Anthropic metadata")
    except HTTPError as error:
        error.read()
        raise IndexingError(
            502 if error.code >= 500 else error.code,
            "ANTHROPIC_METADATA_FAILED",
            "Riconoscimento metadati Anthropic non riuscito.",
            {"status": error.code},
        ) from error
    except (URLError, TimeoutError) as error:
        raise IndexingError(
            502,
            "ANTHROPIC_METADATA_UNAVAILABLE",
            "Anthropic non è raggiungibile per il riconoscimento metadati.",
        ) from error

    blocks = message.get("content") if isinstance(message, dict) else None
    detected = next(
        (
            block.get("input")
            for block in blocks or []
            if isinstance(block, dict)
            and block.get("type") == "tool_use"
            and block.get("name") == "record_catalog_metadata"
            and isinstance(block.get("input"), dict)
        ),
        None,
    )
    if not isinstance(detected, dict) or set(detected) != set(fields):
        raise IndexingError(
            502,
            "ANTHROPIC_METADATA_INVALID",
            "La risposta metadati Anthropic non rispetta lo schema.",
        )
    return detected


def _ai_schema(*, include_page_number: bool = False) -> dict[str, Any]:
    part_properties: dict[str, Any] = {
        "code": {"type": "string", "minLength": 1, "maxLength": 80},
        "description": {
            "type": "string",
            "minLength": 1,
            "maxLength": 1000,
        },
        "original_description": {
            "type": "string",
            "maxLength": 1000,
        },
        "quantity": {
            "anyOf": [
                {"type": "number", "minimum": 0},
                {"type": "null"},
            ]
        },
        "item": {"type": "string", "maxLength": 100},
        "category": {"type": "string", "maxLength": 300},
        "assembly_code": {"type": "string", "maxLength": 100},
        "assembly_title": {"type": "string", "maxLength": 300},
    }
    required = [
        "code",
        "description",
        "original_description",
        "quantity",
        "item",
        "category",
        "assembly_code",
        "assembly_title",
    ]
    if include_page_number:
        part_properties["page_number"] = {"type": "integer", "minimum": 1}
        required.append("page_number")
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "confidence": {"type": "number", "minimum": 0, "maximum": 1},
            "parts": {
                "type": "array",
                "maxItems": 500,
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": part_properties,
                    "required": required,
                },
            },
        },
        "required": ["confidence", "parts"],
    }


def _anthropic_parts_batch(
    pages: list[tuple[bytes, int]],
    brand: str,
    api_key: str,
    model: str,
) -> list[ExtractedPart]:
    if not pages:
        return []
    source_pages = {page_number for _, page_number in pages}
    prompt = (
        "Extract only spare-part table rows visibly present in these page images. "
        "Never infer or complete missing codes. Keep the original description. "
        f"Brand hint: {brand or 'unknown'}. Source pages: {sorted(source_pages)}. "
        "Set page_number to the source page shown before each image. "
        "Return an empty parts array only when none of the images has a parts table."
    )
    content: list[dict[str, Any]] = []
    for page_image, page_number in pages:
        content.extend(
            [
                {"type": "text", "text": f"Source page_number: {page_number}"},
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/png",
                        "data": base64.b64encode(page_image).decode("ascii"),
                    },
                },
            ]
        )
    content.append({"type": "text", "text": prompt})
    payload = {
        "model": model,
        "max_tokens": _env_int("INDEX_AI_MAX_TOKENS", 8192, 1024, 16000),
        "system": (
            "You are a strict spare-parts table transcriber. Your response must "
            "conform exactly to the supplied JSON schema."
        ),
        "messages": [
            {
                "role": "user",
                "content": content,
            }
        ],
        "tools": [
            {
                "name": "record_parts",
                "description": "Record spare-part rows and their source page numbers.",
                "input_schema": _ai_schema(include_page_number=True),
            }
        ],
        "tool_choice": {"type": "tool", "name": "record_parts"},
    }
    timeout = _env_int("INDEX_AI_TIMEOUT_SECONDS", 180, 10, 240)
    request = Request(
        "https://api.anthropic.com/v1/messages",
        data=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            message = _decode_json(response.read(), "Anthropic")
    except HTTPError as error:
        body = error.read()
        try:
            upstream = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            upstream = {"message": body[:300].decode("utf-8", "replace")}
        code = {
            401: "ANTHROPIC_INVALID_KEY",
            403: "ANTHROPIC_FORBIDDEN",
            404: "ANTHROPIC_MODEL_NOT_FOUND",
            429: "ANTHROPIC_RATE_LIMIT",
        }.get(error.code, "ANTHROPIC_REQUEST_FAILED")
        raise IndexingError(
            502 if error.code >= 500 else error.code,
            code,
            "Fallback Anthropic non riuscito.",
            {"status": error.code, "response": upstream},
        ) from error
    except (URLError, TimeoutError) as error:
        raise IndexingError(
            502,
            "ANTHROPIC_UNAVAILABLE",
            "Anthropic non è raggiungibile.",
            {"reason": str(error)},
        ) from error

    blocks = message.get("content") if isinstance(message, dict) else None
    tool_inputs = [
        block.get("input")
        for block in blocks or []
        if isinstance(block, dict)
        and block.get("type") == "tool_use"
        and block.get("name") == "record_parts"
        and isinstance(block.get("input"), dict)
    ]
    if len(tool_inputs) != 1:
        raise IndexingError(
            502,
            "ANTHROPIC_INVALID_JSON",
            "Anthropic non ha invocato record_parts una sola volta.",
        )
    result = tool_inputs[0]
    if not isinstance(result, dict) or set(result) != {"confidence", "parts"}:
        raise IndexingError(
            502,
            "ANTHROPIC_INVALID_JSON",
            "La risposta Anthropic non rispetta lo schema richiesto.",
        )
    confidence = result.get("confidence")
    rows = result.get("parts")
    if (
        not isinstance(confidence, (int, float))
        or isinstance(confidence, bool)
        or not 0 <= confidence <= 1
        or not isinstance(rows, list)
        or len(rows) > 500
    ):
        raise IndexingError(
            502,
            "ANTHROPIC_INVALID_JSON",
            "La risposta Anthropic contiene valori non validi.",
        )

    required = {
        "code",
        "description",
        "original_description",
        "quantity",
        "item",
        "category",
        "assembly_code",
        "assembly_title",
        "page_number",
    }
    parts: list[ExtractedPart] = []
    for index, row in enumerate(rows):
        if not isinstance(row, dict) or set(row) != required:
            raise IndexingError(
                502,
                "ANTHROPIC_INVALID_JSON",
                "Una riga Anthropic non rispetta lo schema richiesto.",
                {"row": index},
            )
        code = row["code"]
        description = row["description"]
        quantity = row["quantity"]
        page_number = row["page_number"]
        string_fields = required - {"quantity", "page_number"}
        if (
            any(not isinstance(row[field], str) for field in string_fields)
            or not isinstance(code, str)
            or not AI_CODE_RE.fullmatch(code.strip())
            or not isinstance(description, str)
            or not description.strip()
            or not isinstance(page_number, int)
            or isinstance(page_number, bool)
            or page_number not in source_pages
            or (
                quantity is not None
                and (
                    not isinstance(quantity, (int, float))
                    or isinstance(quantity, bool)
                    or quantity < 0
                )
            )
        ):
            raise IndexingError(
                502,
                "ANTHROPIC_INVALID_JSON",
                "Una riga Anthropic contiene dati non validi.",
                {"row": index},
            )
        parts.append(
            ExtractedPart(
                code=code,
                description=description,
                original_description=row["original_description"] or description,
                quantity=quantity,
                item=row["item"],
                page=page_number,
                category=row["category"] or "Ricambi",
                assembly_code=row["assembly_code"],
                assembly_title=row["assembly_title"],
                source_type="ai",
                confidence=float(confidence),
                metadata={"extraction": "anthropic"},
            )
        )
    return parts


def _anthropic_parts(
    page_image: bytes,
    page_number: int,
    brand: str,
    api_key: str,
    model: str,
) -> list[ExtractedPart]:
    return _anthropic_parts_batch(
        [(page_image, page_number)],
        brand,
        api_key,
        model,
    )


def _merge_parts(
    deterministic: list[ExtractedPart], ai_parts: list[ExtractedPart]
) -> list[ExtractedPart]:
    unique: dict[tuple[str, str, int], ExtractedPart] = {}
    for part in [*deterministic, *ai_parts]:
        key = (part.code.casefold(), part.item.casefold(), part.page)
        previous = unique.get(key)
        if previous is None or part.confidence > previous.confidence:
            unique[key] = part
    return sorted(unique.values(), key=lambda part: (part.page, part.item, part.code))


def _part_id(catalog_id: str, part: ExtractedPart) -> str:
    identity = "|".join(
        (
            catalog_id,
            part.code.casefold(),
            str(part.page),
            part.assembly_code.casefold(),
            part.item.casefold(),
        )
    )
    return str(uuid.uuid5(uuid.NAMESPACE_URL, identity))


def _part_row(
    catalog_id: str, part: ExtractedPart, schema: str
) -> dict[str, Any]:
    source = {
        "confidence": part.confidence,
        "extraction": part.source_type,
        "original_description": part.original_description,
        "assembly_code": part.assembly_code,
        "assembly_title": part.assembly_title,
        "search_text": part.search_text,
        **part.metadata,
    }
    if part.bbox:
        source["bbox"] = [round(value, 2) for value in part.bbox]
    common_id = _part_id(catalog_id, part)
    if schema == "legacy":
        source_type = (
            part.source_type
            if part.source_type in {"mechanical", "electrical"}
            else "generic"
        )
        return {
            "id": common_id,
            "catalog_id": catalog_id,
            "code": part.code,
            "description": part.description,
            "original_description": part.original_description,
            "quantity": part.quantity,
            "item": part.item or None,
            "page_number": part.page,
            "category": part.category,
            "assembly_code": part.assembly_code or None,
            "assembly_title": part.assembly_title or None,
            "source_type": source_type,
            "confidence": round(part.confidence, 3),
            "bbox": (
                [round(value, 2) for value in part.bbox] if part.bbox else None
            ),
            "metadata": source,
        }
    return {
        "id": common_id,
        "catalog_id": catalog_id,
        "part_number": part.code,
        "description": part.description,
        "quantity": part.quantity,
        "reference": part.original_description or None,
        "category": part.category,
        "assembly": part.assembly_title or None,
        "figure_number": part.assembly_code or None,
        "item_number": part.item or None,
        "page_number": part.page,
        "notes": None,
        "source_data": source,
    }


def _existing_catalog_parts(
    client: SupabaseREST, catalog_id: str
) -> list[ExtractedPart]:
    rows = client.select(
        "parts",
        {
            "catalog_id": f"eq.{catalog_id}",
            "select": (
                "code,description,original_description,quantity,item,page_number,"
                "category,assembly_code,assembly_title,source_type,confidence,metadata"
            ),
            "limit": "100000",
        },
    )
    parts: list[ExtractedPart] = []
    for row in rows:
        try:
            quantity_raw = row.get("quantity")
            quantity = (
                float(quantity_raw)
                if quantity_raw is not None and str(quantity_raw).strip()
                else None
            )
            if quantity is not None and quantity.is_integer():
                quantity = int(quantity)
            confidence_raw = row.get("confidence")
            confidence = (
                float(confidence_raw) if confidence_raw is not None else 0.7
            )
            parts.append(
                ExtractedPart(
                    code=str(row.get("code") or ""),
                    description=str(row.get("description") or ""),
                    original_description=str(
                        row.get("original_description")
                        or row.get("description")
                        or ""
                    ),
                    quantity=quantity,
                    item=str(row.get("item") or ""),
                    page=int(row.get("page_number") or 0),
                    category=str(row.get("category") or "Ricambi"),
                    assembly_code=str(row.get("assembly_code") or ""),
                    assembly_title=str(row.get("assembly_title") or ""),
                    source_type=str(row.get("source_type") or "existing"),
                    confidence=confidence,
                    metadata=(
                        row.get("metadata")
                        if isinstance(row.get("metadata"), dict)
                        else {}
                    ),
                )
            )
        except (TypeError, ValueError):
            continue
    return parts


def _parts_schema(catalog: dict[str, Any]) -> str:
    configured = os.environ.get("INDEX_PARTS_SCHEMA", "auto").strip().lower()
    if configured not in {"auto", "normalized", "legacy"}:
        raise IndexingError(
            503,
            "INVALID_CONFIGURATION",
            "INDEX_PARTS_SCHEMA deve essere auto, normalized o legacy.",
        )
    if configured != "auto":
        return configured
    # The normalized migration uses manufacturer/file_size_bytes; the earlier
    # application schema uses brand/file_size and code/item columns.
    return (
        "normalized"
        if "manufacturer" in catalog or "file_size_bytes" in catalog
        else "legacy"
    )


def _job_update(
    client: SupabaseREST,
    job: dict[str, Any],
    values: dict[str, Any],
    *,
    expected_status: str | None = None,
    return_rows: bool = False,
) -> list[dict[str, Any]]:
    supported = set(job)
    payload = {key: value for key, value in values.items() if key in supported}
    # report is named error_details in the normalized migration.
    if "report" in values and "report" not in supported and "error_details" in supported:
        payload["error_details"] = values["report"]
    query = {"id": f"eq.{job['id']}"}
    if expected_status:
        query["status"] = f"eq.{expected_status}"
    return client.patch("ingestion_jobs", query, payload, return_rows=return_rows)


def _catalog_update(
    client: SupabaseREST,
    catalog: dict[str, Any],
    values: dict[str, Any],
) -> None:
    supported = set(catalog)
    payload = {key: value for key, value in values.items() if key in supported}
    if "metadata" in supported and "report" in values:
        metadata = catalog.get("metadata")
        if not isinstance(metadata, dict):
            metadata = {}
        payload["metadata"] = {**metadata, "indexing": values["report"]}
    client.patch("catalogs", {"id": f"eq.{catalog['id']}"}, payload)


def _failure_updates(
    client: SupabaseREST | None,
    job: dict[str, Any] | None,
    catalog: dict[str, Any] | None,
    error: IndexingError,
) -> None:
    if not client:
        return
    previous_report = job.get("report") if job else None
    if not isinstance(previous_report, dict):
        previous_report = {}
    report = {
        **previous_report,
        "outcome": "failed",
        "code": error.code,
        "message": error.message,
        "details": error.details,
        "failedAt": _utc_now(),
    }
    try:
        if job:
            _job_update(
                client,
                job,
                {
                    "status": "failed",
                    "stage": "failed",
                    "progress": min(int(job.get("progress") or 0), 99),
                    "error_message": error.message,
                    "report": report,
                    "completed_at": _utc_now(),
                },
            )
        if catalog:
            _catalog_update(
                client,
                catalog,
                {"status": "failed", "report": report, "processed_at": _utc_now()},
            )
    except Exception:
        # Preserve the original, actionable error response.
        pass


def _extract(
    client: SupabaseREST,
    job: dict[str, Any],
    catalog: dict[str, Any],
    document: fitz.Document,
    checksum: str,
) -> tuple[list[ExtractedPart], dict[str, Any], str]:
    brand = _catalog_brand(catalog)
    adapter = select_adapter(brand, _catalog_filename(catalog))
    page_results: list[PageExtraction] = []
    deterministic_parts: list[ExtractedPart] = []
    page_count = document.page_count

    for page_index in range(page_count):
        result = adapter.extract_page(document[page_index], page_index + 1)
        page_results.append(result)
        deterministic_parts.extend(result.parts)
        if page_index == page_count - 1 or (page_index + 1) % 10 == 0:
            progress = 10 + int(((page_index + 1) / page_count) * 50)
            job["progress"] = progress
            _job_update(
                client,
                job,
                {
                    "stage": "deterministic_extraction",
                    "progress": progress,
                    "processed_items": page_index + 1,
                    "total_items": page_count,
                },
            )

    suspect_indexes = [
        index
        for index, result in enumerate(page_results)
        if result.text_characters < MIN_TEXT_CHARACTERS
        or (bool(result.parts) and result.confidence < MIN_PAGE_CONFIDENCE)
        or "unparsed_table" in result.reasons
        or "sparse_table" in result.reasons
    ]
    # Pages with actual low-confidence rows have priority over image-only pages.
    suspect_indexes.sort(
        key=lambda index: (
            not bool(page_results[index].parts),
            page_results[index].confidence,
            index,
        )
    )
    previous_report = job.get("report")
    if not isinstance(previous_report, dict):
        previous_report = {}
    completed_before = {
        int(page) - 1
        for page in previous_report.get("completedAiPages", [])
        if isinstance(page, int) and page > 0
    }
    previous_unresolved = {
        int(page) - 1
        for page in previous_report.get("unresolvedPages", [])
        if isinstance(page, int) and page > 0
    }
    resolved_before = completed_before - previous_unresolved
    max_ai_pages = _env_int("INDEX_MAX_AI_PAGES", 80, 0, 500)
    eligible_ai_indexes = suspect_indexes[:max_ai_pages]
    pages_per_run = _env_int("INDEX_AI_PAGES_PER_RUN", 3, 1, 8)
    pending_ai_indexes = [
        index for index in eligible_ai_indexes if index not in completed_before
    ]
    selected_ai_indexes = pending_ai_indexes[:pages_per_run]
    unresolved = set(suspect_indexes) - resolved_before
    ai_parts: list[ExtractedPart] = []
    ai_errors: list[dict[str, Any]] = []
    api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    model = (
        os.environ.get("ANTHROPIC_INDEX_MODEL")
        or os.environ.get("ANTHROPIC_MODEL")
        or ""
    ).strip()

    if selected_ai_indexes and (not api_key or not model):
        missing = [
            name
            for name, value in (
                ("ANTHROPIC_API_KEY", api_key),
                ("ANTHROPIC_INDEX_MODEL/ANTHROPIC_MODEL", model),
            )
            if not value
        ]
        ai_errors.append(
            {
                "code": "ANTHROPIC_NOT_CONFIGURED",
                "message": "Fallback Anthropic non configurato.",
                "missing": missing,
            }
        )
        selected_ai_indexes = []

    ai_batch_pages = _env_int("INDEX_AI_BATCH_PAGES", 3, 1, 8)
    ai_concurrency = _env_int("INDEX_AI_CONCURRENCY", 2, 1, 4)
    completed_this_run: set[int] = set()
    page_batches = [
        selected_ai_indexes[offset : offset + ai_batch_pages]
        for offset in range(0, len(selected_ai_indexes), ai_batch_pages)
    ]
    completed_ai_pages = 0
    for wave_start in range(0, len(page_batches), ai_concurrency):
        wave_batches = page_batches[
            wave_start : wave_start + ai_concurrency
        ]
        # PyMuPDF rendering stays on the request thread; only independent HTTP
        # requests run concurrently.
        wave_indexes = [
            page_index for batch in wave_batches for page_index in batch
        ]
        rendered_pages = {
            page_index: _page_image(document, page_index)
            for page_index in wave_indexes
        }
        with ThreadPoolExecutor(max_workers=len(wave_batches)) as executor:
            futures = {
                executor.submit(
                    _anthropic_parts_batch,
                    [
                        (rendered_pages[page_index], page_index + 1)
                        for page_index in batch
                    ],
                    brand,
                    api_key,
                    model,
                ): batch
                for batch in wave_batches
            }
            for future in as_completed(futures):
                batch = futures[future]
                try:
                    extracted = future.result()
                    ai_parts.extend(extracted)
                    completed_this_run.update(batch)
                    pages_with_parts = {part.page - 1 for part in extracted}
                    for page_index in batch:
                        # Empty is valid for a non-table page, but cannot
                        # resolve an already sparse/partial table.
                        if (
                            page_index in pages_with_parts
                            or not page_results[page_index].parts
                        ):
                            unresolved.discard(page_index)
                except IndexingError as error:
                    for page_index in batch:
                        ai_errors.append(
                            {
                                "page": page_index + 1,
                                "code": error.code,
                                "message": error.message,
                                "details": error.details,
                            }
                        )
                except Exception as error:
                    for page_index in batch:
                        ai_errors.append(
                            {
                                "page": page_index + 1,
                                "code": "ANTHROPIC_INTERNAL_ERROR",
                                "message": type(error).__name__,
                            }
                        )
                completed_ai_pages += len(batch)
        progress = 60 + int(
            (completed_ai_pages / max(len(selected_ai_indexes), 1)) * 15
        )
        job["progress"] = progress
        _job_update(
            client,
            job,
            {
                "stage": "ai_fallback",
                "progress": progress,
                "processed_items": page_count,
                "total_items": page_count,
            },
        )

    completed_cumulative = completed_before | completed_this_run
    remaining_ai_indexes = [
        index
        for index in eligible_ai_indexes
        if index not in completed_cumulative
    ]
    existing_parts = _existing_catalog_parts(client, str(catalog["id"]))
    parts = _merge_parts([*existing_parts, *deterministic_parts], ai_parts)
    if not parts:
        if ai_errors and ai_errors[0].get("code") == "ANTHROPIC_NOT_CONFIGURED":
            raise IndexingError(
                503,
                "ANTHROPIC_NOT_CONFIGURED",
                "Nessun ricambio deterministico e fallback Anthropic non configurato.",
                ai_errors[0],
            )
        raise IndexingError(
            422,
            "NO_PARTS_EXTRACTED",
            "L'indicizzazione non ha trovato righe ricambio verificabili.",
            {"aiErrors": ai_errors},
        )

    outcome = (
        "ready"
        if not unresolved and not ai_errors and not remaining_ai_indexes
        else "needs_review"
    )
    report = {
        "outcome": outcome,
        "adapter": adapter.name,
        "checksumSha256": checksum,
        "pages": page_count,
        "parts": len(parts),
        "deterministicParts": len(deterministic_parts),
        "aiParts": len(ai_parts),
        "aiPages": [index + 1 for index in sorted(completed_cumulative)],
        "aiPagesThisRun": [index + 1 for index in sorted(completed_this_run)],
        "completedAiPages": [
            index + 1 for index in sorted(completed_cumulative)
        ],
        "remainingAiPages": [
            index + 1 for index in remaining_ai_indexes
        ],
        "suspectPages": [index + 1 for index in suspect_indexes],
        "unresolvedPages": [index + 1 for index in sorted(unresolved)],
        "aiErrors": ai_errors,
        "limits": {
            "maxAiPages": max_ai_pages,
            "pagesPerRun": pages_per_run,
            "maxPdfBytes": _env_int(
                "INDEX_MAX_PDF_BYTES",
                DEFAULT_MAX_PDF_BYTES,
                1,
                250 * 1024 * 1024,
            ),
            "batchSize": _env_int(
                "INDEX_PART_BATCH_SIZE", DEFAULT_BATCH_SIZE, 1, 1000
            ),
            "aiConcurrency": ai_concurrency,
            "aiBatchPages": ai_batch_pages,
        },
    }
    return parts, report, outcome


def _run_indexing(
    client: SupabaseREST,
    job: dict[str, Any],
    catalog: dict[str, Any],
) -> tuple[dict[str, Any], int]:
    bucket = os.environ.get("SUPABASE_CATALOG_BUCKET", "catalogs").strip()
    if not bucket:
        raise IndexingError(
            503,
            "INVALID_CONFIGURATION",
            "SUPABASE_CATALOG_BUCKET non può essere vuoto.",
        )
    storage_path = str(
        catalog.get("storage_path")
        or catalog.get("file_path")
        or catalog.get("pdf_path")
        or ""
    )
    _catalog_update(client, catalog, {"status": "processing"})
    content, downloaded_mime = client.download_private_object(bucket, storage_path)
    checksum, document = _validate_pdf(content, downloaded_mime, catalog)
    try:
        detected_metadata = _detect_catalog_metadata(document, catalog)
        if detected_metadata.get("missing"):
            api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
            model = (
                os.environ.get("ANTHROPIC_INDEX_MODEL")
                or os.environ.get("ANTHROPIC_MODEL")
                or ""
            ).strip()
            if api_key and model:
                try:
                    ai_metadata = _anthropic_catalog_metadata(
                        document,
                        _catalog_filename(catalog),
                        api_key,
                        model,
                    )
                    for field in (
                        "brand",
                        "model",
                        "version",
                        "customer",
                        "orderReference",
                        "revision",
                    ):
                        if not detected_metadata.get(field) and ai_metadata.get(field):
                            detected_metadata[field] = _clean_metadata_value(
                                str(ai_metadata[field]),
                                160 if field == "customer" else 100,
                            )
                    if not detected_metadata.get("serialNumbers"):
                        detected_metadata["serialNumbers"] = list(
                            dict.fromkeys(
                                re.sub(r"[^A-Za-z0-9._/-]", "", str(value)).upper()
                                for value in ai_metadata.get("serialNumbers", [])
                                if 3 <= len(str(value)) <= 50
                            )
                        )[:500]
                    detected_metadata["aiConfidence"] = ai_metadata.get("confidence")
                    detected_metadata["source"] = "deterministic+anthropic"
                except IndexingError as error:
                    detected_metadata["aiError"] = {
                        "code": error.code,
                        "message": error.message,
                    }
            else:
                detected_metadata["source"] = "deterministic"
                detected_metadata["aiError"] = {
                    "code": "ANTHROPIC_NOT_CONFIGURED",
                    "message": "Fallback metadati AI non configurato.",
                }
            detected_metadata["missing"] = [
                key
                for key in ("brand", "model", "serialNumbers")
                if not detected_metadata.get(key)
            ]
            detected_metadata["confidence"] = round(
                sum(
                    bool(detected_metadata.get(key))
                    for key in (
                        "brand",
                        "model",
                        "version",
                        "customer",
                        "orderReference",
                        "revision",
                        "serialNumbers",
                    )
                )
                / 7,
                3,
            )
        _apply_detected_metadata(client, catalog, detected_metadata)
        job["progress"] = 8
        _job_update(
            client,
            job,
            {
                "stage": "metadata_detection",
                "progress": 8,
                "processed_items": 0,
                "total_items": document.page_count,
            },
        )
        parts, report, outcome = _extract(client, job, catalog, document, checksum)
        page_count = document.page_count
    finally:
        document.close()

    if detected_metadata.get("missing"):
        outcome = "needs_review"
        report["outcome"] = outcome
    report["detectedMetadata"] = detected_metadata
    schema = _parts_schema(catalog)
    rows = [_part_row(str(catalog["id"]), part, schema) for part in parts]

    # Delete + insert run in one Postgres transaction. A bad row or transport
    # failure cannot leave a previously usable catalog partially replaced.
    accepted = client.replace_catalog_parts(str(catalog["id"]), rows)
    job["progress"] = 95
    _job_update(
        client,
        job,
        {
            "stage": "database_upsert",
            "progress": 95,
            "processed_items": accepted,
            "total_items": len(rows),
        },
    )

    report["partsSchema"] = schema
    report["databaseWrite"] = "atomic"
    report["completedAt"] = _utc_now()
    catalog_values = {
        "status": outcome,
        "checksum_sha256": checksum,
        "page_count": page_count,
        "part_count": len(rows),
        "processed_at": _utc_now(),
        "indexed_at": _utc_now(),
        "report": report,
    }
    _catalog_update(client, catalog, catalog_values)

    job_outcome = outcome if outcome in set(job.get("_allowed_final_statuses", [])) else "completed"
    # Most schemas use completed for a successful job and keep ready/review on
    # the catalog. If the job schema already uses catalog-style states, honor it.
    if job.get("status") in {"ready", "needs_review"}:
        job_outcome = outcome
    _job_update(
        client,
        job,
        {
            "status": job_outcome,
            "stage": outcome,
            "progress": 100,
            "processed_items": len(rows),
            "total_items": len(rows),
            "error_message": None,
            "report": report,
            "completed_at": _utc_now(),
        },
    )
    return {
        "ok": True,
        "jobId": job["id"],
        "catalogId": catalog["id"],
        "status": outcome,
        "parts": len(rows),
        "accepted": accepted,
        "pages": page_count,
        "metadata": detected_metadata,
        "report": report,
    }, 200


def _request_job_id(body: Any) -> str:
    if not isinstance(body, dict):
        raise IndexingError(
            400, "INVALID_REQUEST", "Il body deve essere un oggetto JSON."
        )
    value = body.get("jobId") or body.get("job_id")
    if not isinstance(value, str) or not UUID_RE.fullmatch(value):
        raise IndexingError(
            400,
            "INVALID_JOB_ID",
            "jobId deve essere un UUID valido.",
        )
    return value


class handler(BaseHTTPRequestHandler):
    """Vercel Python function entry point."""

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode(
            "utf-8"
        )
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def do_POST(self) -> None:
        client: SupabaseREST | None = None
        job: dict[str, Any] | None = None
        catalog: dict[str, Any] | None = None
        claimed = False
        started = time.monotonic()
        try:
            authorization = self.headers.get("Authorization", "")
            if not authorization.lower().startswith("bearer "):
                raise IndexingError(
                    401,
                    "AUTH_REQUIRED",
                    "Bearer Supabase richiesto.",
                )
            user_token = authorization[7:].strip()
            if not user_token:
                raise IndexingError(401, "AUTH_REQUIRED", "Bearer Supabase richiesto.")

            content_type = self.headers.get("Content-Type", "").split(";", 1)[0].lower()
            if content_type != "application/json":
                raise IndexingError(
                    415,
                    "INVALID_CONTENT_TYPE",
                    "Content-Type application/json richiesto.",
                )
            try:
                content_length = int(self.headers.get("Content-Length", "0"))
            except ValueError as error:
                raise IndexingError(
                    400, "INVALID_REQUEST", "Content-Length non valido."
                ) from error
            if content_length <= 0 or content_length > 16 * 1024:
                raise IndexingError(
                    400,
                    "INVALID_REQUEST",
                    "Body JSON vuoto o troppo grande.",
                )
            try:
                body = json.loads(self.rfile.read(content_length))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise IndexingError(
                    400, "INVALID_JSON", "Body JSON non valido."
                ) from error
            job_id = _request_job_id(body)

            url, service_key = _required_environment()
            client = SupabaseREST(url, service_key)
            client.authenticate_admin(user_token)

            jobs = client.select(
                "ingestion_jobs", {"id": f"eq.{job_id}", "select": "*", "limit": "1"}
            )
            if not jobs:
                raise IndexingError(
                    404, "JOB_NOT_FOUND", "Job di indicizzazione non trovato."
                )
            job = jobs[0]
            catalog_id = job.get("catalog_id")
            if not isinstance(catalog_id, str):
                raise IndexingError(
                    422,
                    "INVALID_JOB",
                    "Il job non contiene un catalog_id valido.",
                )
            requested_catalog = body.get("catalogId") or body.get("catalog_id")
            if requested_catalog is not None and requested_catalog != catalog_id:
                raise IndexingError(
                    409,
                    "CATALOG_JOB_MISMATCH",
                    "Il catalogo richiesto non appartiene al job.",
                )
            catalogs = client.select(
                "catalogs",
                {"id": f"eq.{catalog_id}", "select": "*", "limit": "1"},
            )
            if not catalogs:
                raise IndexingError(
                    404, "CATALOG_NOT_FOUND", "Catalogo non trovato."
                )
            catalog = catalogs[0]

            status = str(job.get("status") or "")
            retrying_review = (
                status == "completed" and catalog.get("status") == "needs_review"
            )
            retrying_stale = status == "running" and _stale_running_job(job)
            if (
                status not in {"queued", "failed"}
                and not retrying_review
                and not retrying_stale
            ):
                raise IndexingError(
                    409,
                    "JOB_NOT_RUNNABLE",
                    "Il job non è in uno stato avviabile.",
                    {"status": status},
                )
            started_at = _utc_now()
            prior_report = job.get("report")
            if not isinstance(prior_report, dict):
                prior_report = {}
            locked = _job_update(
                client,
                job,
                {
                    "status": "running",
                    "stage": "download",
                    "progress": 1,
                    "processed_items": 0,
                    "error_message": None,
                    "report": {
                        **prior_report,
                        "outcome": "running",
                        "lastStartedAt": started_at,
                    },
                    "started_at": started_at,
                    "completed_at": None,
                },
                expected_status=status,
                return_rows=True,
            )
            if not locked:
                raise IndexingError(
                    409,
                    "JOB_ALREADY_CLAIMED",
                    "Il job è già stato avviato da un altro processo.",
                )
            job.update(locked[0])
            claimed = True
            response, response_status = _run_indexing(client, job, catalog)
            response["elapsedSeconds"] = round(time.monotonic() - started, 3)
            self._send_json(response_status, response)
        except IndexingError as error:
            if claimed:
                _failure_updates(client, job, catalog, error)
            self._send_json(error.status, error.payload())
        except Exception as error:
            unexpected = IndexingError(
                500,
                "INDEXING_INTERNAL_ERROR",
                "Errore interno durante l'indicizzazione.",
                {"type": type(error).__name__},
            )
            if claimed:
                _failure_updates(client, job, catalog, unexpected)
            self._send_json(500, unexpected.payload())

    def do_GET(self) -> None:
        self.send_response(405)
        self.send_header("Allow", "POST")
        self.send_header("Content-Type", "application/json; charset=utf-8")
        payload = b'{"error":"Metodo non consentito.","code":"METHOD_NOT_ALLOWED"}'
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

