# Authorized Nine Dataset Extractor Design

## Purpose

Create a local/offline importer for authorized GeeTest `nine`-style image datasets. The importer normalizes already-saved challenge images into the dataset shape consumed by the existing manual label server:

```text
dataset/raw-authorized/<id>/
  grid.jpg
  ques.png
  meta.json
```

This is intentionally not a live platform collector. It does not open registration/login flows, call GeeTest endpoints, or fetch remote images.

## Inputs

The importer accepts one of two local input forms:

- `--manifest <file>`: JSON or JSONL records with local `gridPath`/`quesPath` paths.
- `--in <directory>`: challenge subdirectories that already contain `grid.jpg`, `ques.png`, and optional `meta.json`.

Remote references such as `http:`, `https:`, and `data:` are rejected. Relative paths in manifests resolve from the manifest directory.

## Metadata

Each output `meta.json` preserves source metadata and guarantees the fields required by the label server:

- `id`
- `captchaType`
- `captchaId`
- `lotNumber`
- `nineNums`
- `sourceId`
- `originalGridPath`
- `originalQuesPath`
- `importedAt`

Missing `captchaId`, `lotNumber`, or `nineNums` receive local defaults suitable for offline labeling.

## CLI

```bash
npm run extract:nine-authorized -- --manifest captures.jsonl --out dataset/raw-authorized
npm run extract:nine-authorized -- --in captures-dir --out dataset/raw-authorized --append
```

The default output is `dataset/raw-authorized`.

## Testing

Tests cover manifest import, directory import with append behavior, and rejection of remote image references.
