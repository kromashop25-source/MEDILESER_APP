"""Migración controlada de SQLite (vi.db) hacia MySQL.

- Preserva IDs para mantener integridad referencial.
- Orden de carga: user -> oi -> bancada.
- Soporta el caso donde `allowed_modules` exista o no en SQLite.
- Crea las tablas en MySQL si no existen (SQLModel.metadata.create_all).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path
import sqlite3

from sqlmodel import SQLModel, create_engine
from sqlalchemy import text, insert, func, select
from sqlalchemy.engine.url import make_url

REPO_ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = REPO_ROOT / "backend"
DEFAULT_SQLITE_PATH = BACKEND_DIR / "data" / "vi.db"

# Asegura imports del paquete `app` (backend/app)
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.models import User, OI, Bancada  # noqa: E402


def _parse_dt(value):
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    try:
        return datetime.fromisoformat(str(value))
    except Exception:
        return None


def _parse_json(value):
    if value is None:
        return None
    if isinstance(value, (dict, list)):
        return value
    s = str(value).strip()
    if not s:
        return None
    try:
        return json.loads(s)
    except Exception:
        return None


def _sqlite_has_column(conn: sqlite3.Connection, table: str, column: str) -> bool:
    cur = conn.execute(f"PRAGMA table_info('{table}')")
    cols = [r[1] for r in cur.fetchall()]
    return column in cols


def _fetch_all(conn: sqlite3.Connection, query: str):
    conn.row_factory = sqlite3.Row
    cur = conn.execute(query)
    return [dict(r) for r in cur.fetchall()]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
    "--sqlite-path",
    default=str(DEFAULT_SQLITE_PATH),
    help="Ruta al archivo SQLite (vi.db). Default: backend/data/vi.db",
)

    parser.add_argument(
        "--mysql-url",
        default=os.getenv("VI_DATABASE_URL") or os.getenv("DATABASE_URL") or "",
        help="URL MySQL SQLAlchemy (mysql+pymysql://...). Si no se pasa, usa VI_DATABASE_URL.",
    )
    parser.add_argument(
        "--wipe",
        action="store_true",
        help="Borra datos existentes en MySQL antes de insertar (bancada -> oi -> user).",
    )
    args = parser.parse_args()

    sqlite_path = Path(args.sqlite_path).resolve()
    if not sqlite_path.exists():
        raise SystemExit(f"No existe SQLite: {sqlite_path}")

    if not args.mysql_url:
        raise SystemExit("Falta --mysql-url o variable de entorno VI_DATABASE_URL.")

    url = make_url(args.mysql_url)
    if url.get_backend_name() != "mysql":
        raise SystemExit(f"La URL no parece MySQL: {args.mysql_url}")

    mysql_engine = create_engine(args.mysql_url, echo=False, pool_pre_ping=True, pool_recycle=280)

    # 1) Crear tablas en MySQL si no existen
    SQLModel.metadata.create_all(mysql_engine)

    # 2) Leer SQLite
    sqlite_conn = sqlite3.connect(str(sqlite_path))
    try:
        has_allowed_modules = _sqlite_has_column(sqlite_conn, "user", "allowed_modules")

        users = _fetch_all(
            sqlite_conn,
            "SELECT id, username, first_name, last_name, password_hash, tech_number, role, is_active"
            + (", allowed_modules" if has_allowed_modules else "")
            + " FROM user ORDER BY id",
        )
        ois = _fetch_all(
            sqlite_conn,
            "SELECT id, code, q3, alcance, pma, presion_bar, banco_id, tech_number, locked_by_user_id, locked_at, "
            "numeration_type, created_at, updated_at "
            "FROM oi ORDER BY id",
        )
        bancadas = _fetch_all(
            sqlite_conn,
            "SELECT id, oi_id, item, medidor, estado, rows, rows_data, created_at, updated_at "
            "FROM bancada ORDER BY id",
        )
    finally:
        sqlite_conn.close()

    # 3) Preparar datos (tipos)
    user_rows = []
    for u in users:
        row = {
            "id": u["id"],
            "username": u["username"],
            "first_name": u["first_name"],
            "last_name": u["last_name"],
            "password_hash": u["password_hash"],
            "tech_number": u["tech_number"],
            "role": u["role"],
            "is_active": bool(u["is_active"]),
            "allowed_modules": _parse_json(u.get("allowed_modules")) if has_allowed_modules else None,
        }
        user_rows.append(row)

    oi_rows = []
    for o in ois:
        oi_rows.append(
            {
                "id": o["id"],
                "code": o["code"],
                "q3": o["q3"],
                "alcance": o["alcance"],
                "pma": o["pma"],
                "presion_bar": o["presion_bar"],
                "banco_id": o["banco_id"],
                "tech_number": o["tech_number"],
                "locked_by_user_id": o["locked_by_user_id"],
                "locked_at": _parse_dt(o["locked_at"]),
                "numeration_type": o["numeration_type"],
                "created_at": _parse_dt(o["created_at"]),
                "updated_at": _parse_dt(o["updated_at"]),
            }
        )

    bancada_rows = []
    for b in bancadas:
        bancada_rows.append(
            {
                "id": b["id"],
                "oi_id": b["oi_id"],
                "item": b["item"],
                "medidor": b["medidor"],
                "estado": b["estado"],
                "rows": b["rows"],
                "rows_data": _parse_json(b["rows_data"]),
                "created_at": _parse_dt(b["created_at"]),
                "updated_at": _parse_dt(b["updated_at"]),
            }
        )

    # 4) Insertar en MySQL
    with mysql_engine.begin() as conn:
        preparer = mysql_engine.dialect.identifier_preparer

        if args.wipe:
            conn.execute(text("SET FOREIGN_KEY_CHECKS=0;"))
            conn.execute(Bancada.__table__.delete())
            conn.execute(OI.__table__.delete())
            conn.execute(User.__table__.delete())
            conn.execute(text("SET FOREIGN_KEY_CHECKS=1;"))

        if not args.wipe:
            user_count = conn.execute(select(func.count()).select_from(User.__table__)).scalar_one()
            oi_count = conn.execute(select(func.count()).select_from(OI.__table__)).scalar_one()
            bancada_count = conn.execute(select(func.count()).select_from(Bancada.__table__)).scalar_one()
            if user_count or oi_count or bancada_count:
                raise SystemExit(
                    f"MySQL no está vacío (user={user_count}, oi={oi_count}, bancada={bancada_count}). "
                    "Ejecuta con --wipe o usa una BD limpia."
                )

        if user_rows:
            conn.execute(insert(User.__table__), user_rows)
        if oi_rows:
            conn.execute(insert(OI.__table__), oi_rows)
        if bancada_rows:
            conn.execute(insert(Bancada.__table__), bancada_rows)

        # Ajustar AUTO_INCREMENT al max(id)+1
        conn.execute(text("SET FOREIGN_KEY_CHECKS=0;"))
        for table_obj in (User.__table__, OI.__table__, Bancada.__table__):
            max_id = conn.execute(select(func.coalesce(func.max(table_obj.c.id), 0))).scalar_one()
            quoted = preparer.quote(table_obj.name)
            conn.execute(text(f"ALTER TABLE {quoted} AUTO_INCREMENT = {int(max_id) + 1};"))
        conn.execute(text("SET FOREIGN_KEY_CHECKS=1;"))

        user_count = conn.execute(select(func.count()).select_from(User.__table__)).scalar_one()
        oi_count = conn.execute(select(func.count()).select_from(OI.__table__)).scalar_one()
        bancada_count = conn.execute(select(func.count()).select_from(Bancada.__table__)).scalar_one()

    print("Migración completada.")
    print(f"user: {len(user_rows)} -> {user_count}")
    print(f"oi: {len(oi_rows)} -> {oi_count}")
    print(f"bancada: {len(bancada_rows)} -> {bancada_count}")


if __name__ == "__main__":
    main()
