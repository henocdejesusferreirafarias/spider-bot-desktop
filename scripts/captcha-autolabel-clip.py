from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path
from typing import Iterable

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "GeekedTest-main"))
from geeked.clip_shared import encode_images  # noqa: E402


def rgba_to_rgb_white(path: Path) -> np.ndarray:
    img = Image.open(path).convert("RGBA")
    rgba = np.asarray(img).astype(np.float32) / 255.0
    rgb = rgba[:, :, :3]
    alpha = rgba[:, :, 3:4]
    return ((rgb * alpha + np.ones_like(rgb) * (1.0 - alpha)) * 255.0).astype(np.uint8)


def grid_cells(path: Path) -> list[tuple[int, int, Image.Image, np.ndarray]]:
    img = Image.open(path).convert("RGB")
    w, h = img.size
    cw, ch = w // 3, h // 3
    cells = []
    for row in range(3):
        for col in range(3):
            crop = img.crop((col * cw, row * ch, (col + 1) * cw, (row + 1) * ch))
            cells.append((row + 1, col + 1, crop, np.asarray(crop)))
    return cells


def iter_challenges(raw_root: Path) -> Iterable[Path]:
    for child in sorted(raw_root.iterdir()):
        if child.is_dir() and (child / "grid.jpg").exists() and (child / "ques.png").exists() and (child / "meta.json").exists():
            yield child


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw", default="dataset/raw")
    parser.add_argument("--out", default="dataset/labeled")
    parser.add_argument("--manifest", default="dataset/labels.jsonl")
    parser.add_argument("--min-score", type=float, default=-1.0)
    args = parser.parse_args()

    raw_root = Path(args.raw)
    out_root = Path(args.out)
    manifest = Path(args.manifest)
    out_root.mkdir(parents=True, exist_ok=True)
    manifest.parent.mkdir(parents=True, exist_ok=True)

    written = 0
    with manifest.open("w", encoding="utf-8") as mf:
        for challenge in iter_challenges(raw_root):
            meta = json.loads((challenge / "meta.json").read_text(encoding="utf-8"))
            target = meta["targetClass"]
            nine_nums = int(meta.get("nineNums", 3))
            ques_rgb = rgba_to_rgb_white(challenge / "ques.png")
            cells = grid_cells(challenge / "grid.jpg")
            embs = encode_images([ques_rgb] + [cell[3] for cell in cells])
            query = embs[0]
            scores = (embs[1:] @ query.T).flatten()
            ranked = sorted(
                [(float(scores[i]), cells[i][0], cells[i][1], cells[i][2]) for i in range(len(cells))],
                reverse=True,
                key=lambda item: item[0],
            )
            for rank, (score, row, col, crop) in enumerate(ranked[:nine_nums], start=1):
                if score < args.min_score:
                    continue
                class_dir = out_root / target
                class_dir.mkdir(parents=True, exist_ok=True)
                name = f"{challenge.name}__r{row}c{col}.jpg"
                rel = Path("dataset/labeled") / target / name
                crop.save(out_root / target / name, quality=95)
                mf.write(json.dumps({
                    "challengeId": challenge.name,
                    "targetClass": target,
                    "row": row,
                    "col": col,
                    "rank": rank,
                    "clipScore": score,
                    "cellPath": str(rel).replace("\\", "/"),
                    "gridPath": str(challenge / "grid.jpg").replace("\\", "/"),
                    "quesPath": str(challenge / "ques.png").replace("\\", "/"),
                }, separators=(",", ":")) + "\n")
                written += 1
    print(f"labeled_cells={written}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
