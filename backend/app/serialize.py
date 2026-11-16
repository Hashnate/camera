"""Turn SQLAlchemy rows into the same JSON shapes the original Prisma API returned."""

import enum
from datetime import datetime
from typing import Any

from sqlalchemy import inspect as sa_inspect


def value(v: Any) -> Any:
    if isinstance(v, datetime):
        # Stored as naive UTC; emit like JS Date#toISOString(): 2026-11-14T06:39:41.123Z
        return v.isoformat(timespec="milliseconds") + "Z"
    if isinstance(v, enum.Enum):
        return v.value
    return v


def ser(obj: Any, *, only: tuple[str, ...] | None = None, **relations: Any) -> dict | None:
    """Serialize a row's columns under their camelCase DB names, plus any included relations.

    `only` restricts output to the given column names (like Prisma's `select`).
    """
    if obj is None:
        return None
    out: dict[str, Any] = {}
    for attr in sa_inspect(obj).mapper.column_attrs:
        name = attr.columns[0].name
        if only is None or name in only:
            out[name] = value(getattr(obj, attr.key))
    out.update(relations)
    return out


def ser_all(rows, **kwargs) -> list[dict]:
    return [ser(r, **kwargs) for r in rows]
