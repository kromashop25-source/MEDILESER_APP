from __future__ import annotations
import os
from pathlib import Path
from datetime import datetime

EXCLUDES = {
    ".venv", "__pycache__", ".pytest_cache", ".mypy_cache",
    ".git", "dist", "build", ".buildvenv", ".cache", ".ruff_cache",
    "node_modules",
}
MAX_DEPTH = 10 # Ajustar dependiendo de la profundidad del repositorio

def format_tree(root: Path, prefix: str = "", depth: int = 0) -> list[str]:
    if depth > MAX_DEPTH:
        return [f"{prefix}... (max depth reached)"]
    lines = []
    try:
        entries = sorted([e for e in root.iterdir() if e.name not in EXCLUDES], key=lambda p: (p.is_file(), p.name.lower()))
    except PermissionError:
        return [f"{prefix}[Permisos denegados]{root}"]
    for i, entry in enumerate(entries):
        connector = "└── " if i == len(entries) - 1 else "├── "
        lines.append(f"{prefix}{connector}{entry.name}")
        if entry.is_dir():
            extension = "    " if i == len(entries) - 1 else "│   "
            lines.extend(format_tree(entry, prefix + extension, depth + 1))
    return lines

def main():
    repo_root = Path(__file__).resolve().parents[1]  # /proyecto
    lines = [repo_root.name]
    lines.extend(format_tree(repo_root))
    out_dir = repo_root / "docs"
    out_dir.mkdir(exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    out_file = out_dir / f"repo_tree-{stamp}.txt"
    out_file.write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines))
    print(f"\nGuardado en: {out_file}")

if __name__ == "__main__":
    main() 