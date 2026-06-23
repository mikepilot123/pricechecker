#!/usr/bin/env python3
"""Build a bundled, offline device-image catalog from Wikimedia Commons.

The shipped site only reads assets/device-images/catalog.json and local WebP
files. Wikimedia is contacted by this maintenance script, never by visitors.
Run it when the price-sheet gains models:

  python3 scripts/build-device-image-catalog.py
"""

from __future__ import annotations

import csv
import io
import json
import re
import time
import urllib.parse
import urllib.request
import urllib.error
from pathlib import Path

from PIL import Image

SHEET_BASE = "https://docs.google.com/spreadsheets/d/e/2PACX-1vTRAjtrKggslKZ32dsGE9GpRizu7qJOMJscTZg04MVDwssg199lNXRClV692KeUdTtkveaM8yiBrThu/pub"
GIDS = ("0", "1256027568")
OUT = Path("assets/device-images")
CATALOG = OUT / "catalog.json"
USER_AGENT = "JQ-Electronics-device-catalog/1.0 (local catalog build)"


def get_json(url: str):
    return request_with_retry(url, json.load)


def request_with_retry(url: str, reader):
    for attempt in range(5):
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return reader(response)
        except urllib.error.HTTPError as exc:
            if exc.code != 429 or attempt == 4:
                raise
            time.sleep(8 * (attempt + 1))


def get_models():
    seen, models = set(), []
    for gid in GIDS:
        url = f"{SHEET_BASE}?gid={gid}&single=true&output=csv"
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(request, timeout=30) as response:
            rows = list(csv.reader(io.TextIOWrapper(response, encoding="utf-8")))
        header = next((i for i, row in enumerate(rows) if row and row[0].strip().lower() == "model"), -1)
        for row in rows[header + 1 :]:
            name = row[0].strip() if row else ""
            if not name or re.search(r"series|^table\d*$", name, re.I):
                continue
            if name not in seen:
                seen.add(name)
                models.append(name)
    return models


def slug(name: str):
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def search_query(name: str):
    # Sheet entries sometimes combine models. The first named model is the
    # least surprising catalog visual for those entries.
    name = name.split("/")[0].strip()
    return name + " back"


def title_matches_model(title: str, name: str):
    text = title.lower()
    model = name.lower().split("/")[0].strip()
    if model.startswith("iphone"):
        if "iphone" not in text:
            return False
        tail = model.removeprefix("iphone").strip()
        tokens = tail.split()
        if not all(re.search(r"\b" + re.escape(token) + r"\b", text) for token in tokens):
            return False
        variants = {"mini", "plus", "pro", "max"}
        return not any(variant in text and variant not in tokens for variant in variants)
    if model.startswith("ipad"):
        if "ipad" not in text:
            return False
        return all(re.search(r"\b" + re.escape(token) + r"\b", text) for token in model.split()[1:2])
    tokens = [token for token in re.findall(r"[a-z0-9]+", model) if len(token) > 1]
    return all(re.search(r"\b" + re.escape(token) + r"\b", text) for token in tokens)


def find_image(name: str):
    params = {
        "action": "query",
        "generator": "search",
        "gsrsearch": search_query(name),
        "gsrnamespace": "6",
        "gsrlimit": "10",
        "prop": "imageinfo",
        "iiprop": "url|extmetadata",
        "iiurlwidth": "480",
        "format": "json",
        "origin": "*",
    }
    data = get_json("https://commons.wikimedia.org/w/api.php?" + urllib.parse.urlencode(params))
    pages = list(data.get("query", {}).get("pages", {}).values())
    if not pages:
        return None

    tokens = [t for t in re.findall(r"[a-z0-9]+", name.lower()) if t not in {"iphone", "samsung", "galaxy"}]
    def score(page):
        title = page.get("title", "").lower()
        value = sum(3 for token in tokens if token in title)
        value += 8 if re.search(r"\b(back|rear)\b", title) else 0
        value -= 6 if "front" in title else 0
        value -= 3 if "macbook" in title else 0
        return value

    pages = [page for page in pages if title_matches_model(page.get("title", ""), name)]
    if not pages:
        return None
    page = max(pages, key=score)
    info = (page.get("imageinfo") or [{}])[0]
    url = info.get("thumburl") or info.get("url")
    if not url or url.lower().endswith(".svg"):
        return None
    metadata = info.get("extmetadata") or {}
    return {
        "url": url,
        "source": info.get("descriptionurl", ""),
        "title": page.get("title", ""),
        "license": metadata.get("LicenseShortName", {}).get("value", "Wikimedia Commons"),
        "credit": metadata.get("Artist", {}).get("value", ""),
    }


def download_webp(source_url: str, target: Path):
    raw = request_with_retry(source_url, lambda response: response.read())
    image = Image.open(io.BytesIO(raw)).convert("RGBA")
    image.thumbnail((480, 480), Image.Resampling.LANCZOS)
    target.parent.mkdir(parents=True, exist_ok=True)
    image.save(target, "WEBP", quality=84, method=6)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    catalog = json.loads(CATALOG.read_text(encoding="utf-8")) if CATALOG.exists() else {}
    for index, model in enumerate(get_models(), start=1):
        print(f"[{index}] {model}")
        existing = catalog.get(model.lower())
        if existing and (OUT / existing.get("file", "")).exists():
            print("  already bundled")
            continue
        try:
            image = find_image(model)
        except Exception as exc:
            print("  lookup failed:", exc)
            continue
        if not image:
            print("  no Commons image found")
            continue
        filename = slug(model) + ".webp"
        if not (OUT / filename).exists():
            try:
                download_webp(image["url"], OUT / filename)
            except Exception as exc:
                print("  download failed:", exc)
                continue
        image["file"] = filename
        catalog[model.lower()] = image
        CATALOG.write_text(json.dumps(catalog, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        # Commons deliberately rate-limits bulk catalog construction.
        time.sleep(3)

    CATALOG.write_text(json.dumps(catalog, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {len(catalog)} bundled model images to {OUT}")


if __name__ == "__main__":
    main()
