#!/usr/bin/env python3
"""Convert Loyverse product images to WebP and update image-map.json."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, ImageOps


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MAP_PATH = REPO_ROOT / "Images" / "loyverse" / "menu" / "image-map.json"


def repo_relative(path: Path) -> str:
    return path.relative_to(REPO_ROOT).as_posix()


def convert_image(source_path: Path, output_path: Path, quality: int, max_dimension: int) -> int:
    with Image.open(source_path) as image:
        image = ImageOps.exif_transpose(image)
        if max_dimension > 0:
            image.thumbnail((max_dimension, max_dimension), Image.Resampling.LANCZOS)
        if image.mode not in ("RGB", "RGBA"):
            image = image.convert("RGBA" if "A" in image.getbands() else "RGB")
        output_path.parent.mkdir(parents=True, exist_ok=True)
        image.save(output_path, "WEBP", quality=quality, method=6)
    return output_path.stat().st_size


def main() -> int:
    parser = argparse.ArgumentParser(description="Convert Loyverse menu images to WebP.")
    parser.add_argument("--map", default=str(DEFAULT_MAP_PATH), help="Path to image-map.json")
    parser.add_argument("--quality", type=int, default=82, help="WebP quality 1-100")
    parser.add_argument("--max-dimension", type=int, default=1200, help="Maximum width/height, 0 keeps original size")
    parser.add_argument("--delete-originals", action="store_true", help="Delete source JPG/PNG files after conversion")
    args = parser.parse_args()

    map_path = Path(args.map).resolve()
    data = json.loads(map_path.read_text(encoding="utf-8"))
    items = data.get("items") or []

    converted = []
    skipped = []
    now = datetime.now(timezone.utc).isoformat()

    for item in items:
        image_url = item.get("imageUrl") or ""
        if not image_url:
            skipped.append({"id": item.get("id"), "reason": "missing-imageUrl"})
            continue

        source_path = (REPO_ROOT / image_url).resolve()
        if source_path.suffix.lower() == ".webp":
            skipped.append({"id": item.get("id"), "reason": "already-webp"})
            continue
        if not source_path.exists():
            skipped.append({"id": item.get("id"), "reason": "source-not-found", "source": image_url})
            continue

        output_path = source_path.with_suffix(".webp")
        original_size = source_path.stat().st_size
        output_size = convert_image(source_path, output_path, args.quality, args.max_dimension)

        item.setdefault("originalImageUrl", image_url)
        item.setdefault("originalByteSize", original_size)
        item["imageUrl"] = repo_relative(output_path)
        item["byteSize"] = output_size
        item["contentType"] = "image/webp"
        item["optimizedAt"] = now
        item["optimizedFormat"] = "webp"
        item["optimizedQuality"] = args.quality

        if args.delete_originals and source_path != output_path:
            source_path.unlink()

        converted.append({
            "id": item.get("id"),
            "from": image_url,
            "to": item["imageUrl"],
            "originalByteSize": original_size,
            "byteSize": output_size,
        })

    data["optimizedAt"] = now
    data["optimizedFormat"] = "webp"
    data["optimizedQuality"] = args.quality
    data["convertedToWebp"] = len(converted)

    map_path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "mapPath": str(map_path),
        "converted": len(converted),
        "skipped": len(skipped),
        "skippedItems": skipped[:20],
    }, ensure_ascii=False, indent=2))
    return 1 if any(item.get("reason") == "source-not-found" for item in skipped) else 0


if __name__ == "__main__":
    raise SystemExit(main())
