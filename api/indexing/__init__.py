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
]
