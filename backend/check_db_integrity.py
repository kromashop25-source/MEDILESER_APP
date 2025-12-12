import sqlite3
from pathlib import Path

# Ruta a la copia de la bd (ajusta según donde la pusiste)
db_path = Path(r"D:\RegistroApp\data\vi.db"
)

print(f"Revisando base: {db_path}")

conn = sqlite3.connect(db_path)
cur = conn.cursor()

# 1) PRAGMA integrity_check
cur.execute("PRAGMA integrity_check;")
result = cur.fetchone()[0]
print("Resultado integrity_check:", result)

# 2) Prueba rápida de tablas importantes
for table in ("oi", "bancada"):
    try:
        cur.execute(f"SELECT COUNT(*) FROM {table};")
        count = cur.fetchone()[0]
        print(f"Rows en {table}: {count}")
    except Exception as e:
        print(f"Error leyendo tabla {table}: {e}")

conn.close()
