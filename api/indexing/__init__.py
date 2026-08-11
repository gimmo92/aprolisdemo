"""Catalog indexing primitives shared by the Vercel Python endpoint."""

from .adapters import (
    BaseAdapter,
    CharlatteAdapter,
    ExtractedPart,
    FiorentiniAdapter,
    GenericAdapter,
    HangchaAdapter,
    MovexxAdapter,
    PageExtraction,
    select_adapter,
)
from .exploded import asset_rows, extract_exploded_assets

__all__ = [
    "BaseAdapter",
    "CharlatteAdapter",
    "ExtractedPart",
    "FiorentiniAdapter",
    "GenericAdapter",
    "HangchaAdapter",
    "MovexxAdapter",
    "PageExtraction",
    "select_adapter",
    "asset_rows",
    "extract_exploded_assets",
]
