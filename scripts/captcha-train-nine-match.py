from __future__ import annotations

import argparse
import json
import random
import tempfile
import warnings
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch
import torch.nn.functional as F
from PIL import Image
from torch import nn
from torch.utils.data import DataLoader, Dataset, WeightedRandomSampler
from torchvision import models, transforms

MEAN = [0.485, 0.456, 0.406]
STD = [0.229, 0.224, 0.225]
PAIR_WIDTH = 128
PAIR_HEIGHT = 64
CELL_SIZE = 64


@dataclass(frozen=True)
class PairSample:
    challenge_id: str
    grid_path: Path
    ques_path: Path
    row: int
    col: int
    label: int


class NineMatchDataset(Dataset):
    def __init__(self, samples: list[PairSample], transform: transforms.Compose):
        self.samples = samples
        self.transform = transform

    def __len__(self) -> int:
        return len(self.samples)

    def __getitem__(self, idx: int):
        sample = self.samples[idx]
        return self.transform(make_pair_image(sample)), torch.tensor([sample.label], dtype=torch.float32)


def load_final_labels(labels_path: Path) -> dict[str, set[tuple[int, int]]]:
    labels: dict[str, set[tuple[int, int]]] = {}
    with labels_path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            item = json.loads(line)
            if item.get("kind") != "final":
                continue
            cells = item.get("cells")
            if not isinstance(cells, list) or not cells:
                raise ValueError(f"invalid final cells for {item.get('challengeId')}")
            labels[str(item["challengeId"])] = {(int(row), int(col)) for row, col in cells}
    if not labels:
        raise ValueError(f"no final labels found in {labels_path}")
    return labels


def collect_samples(raw_dir: Path, labels_path: Path) -> list[PairSample]:
    labels = load_final_labels(labels_path)
    samples: list[PairSample] = []
    missing: list[str] = []
    for challenge_id, positive_cells in sorted(labels.items()):
        challenge_dir = raw_dir / challenge_id
        grid_path = challenge_dir / "grid.jpg"
        ques_path = challenge_dir / "ques.png"
        if not grid_path.exists() or not ques_path.exists():
            missing.append(challenge_id)
            continue
        for row in range(1, 4):
            for col in range(1, 4):
                samples.append(PairSample(
                    challenge_id=challenge_id,
                    grid_path=grid_path,
                    ques_path=ques_path,
                    row=row,
                    col=col,
                    label=1 if (row, col) in positive_cells else 0,
                ))
    if missing:
        raise ValueError(f"{len(missing)} labeled challenges are missing raw files; first={missing[0]}")
    if not samples:
        raise ValueError("no pair samples built")
    return samples


def crop_cell(grid: Image.Image, row: int, col: int) -> Image.Image:
    width, height = grid.size
    cell_width = width // 3
    cell_height = height // 3
    left = (col - 1) * cell_width
    top = (row - 1) * cell_height
    return grid.crop((left, top, left + cell_width, top + cell_height))


def prompt_to_rgb(prompt: Image.Image, background: tuple[int, int, int] = (255, 255, 255)) -> Image.Image:
    rgba = prompt.convert("RGBA")
    canvas = Image.new("RGBA", rgba.size, (*background, 255))
    canvas.alpha_composite(rgba)
    return canvas.convert("RGB")


def make_pair_image(sample: PairSample) -> Image.Image:
    ques = prompt_to_rgb(Image.open(sample.ques_path)).resize((CELL_SIZE, CELL_SIZE), Image.Resampling.BILINEAR)
    grid = Image.open(sample.grid_path).convert("RGB")
    cell = crop_cell(grid, sample.row, sample.col).resize((CELL_SIZE, CELL_SIZE), Image.Resampling.BILINEAR)
    pair = Image.new("RGB", (PAIR_WIDTH, PAIR_HEIGHT))
    pair.paste(ques, (0, 0))
    pair.paste(cell, (CELL_SIZE, 0))
    return pair


def split_by_challenge(samples: list[PairSample], seed: int):
    ids = sorted({sample.challenge_id for sample in samples})
    rng = random.Random(seed)
    rng.shuffle(ids)
    n = len(ids)
    test_n = max(1, round(n * 0.15))
    val_n = max(1, round(n * 0.15))
    test_ids = set(ids[:test_n])
    val_ids = set(ids[test_n:test_n + val_n])
    train_ids = set(ids[test_n + val_n:])
    train = [sample for sample in samples if sample.challenge_id in train_ids]
    val = [sample for sample in samples if sample.challenge_id in val_ids]
    test = [sample for sample in samples if sample.challenge_id in test_ids]
    return train, val, test


def transform_train():
    return transforms.Compose([
        transforms.ColorJitter(brightness=0.18, contrast=0.18, saturation=0.12),
        transforms.RandomAffine(degrees=0, translate=(0.04, 0.04), scale=(0.96, 1.04)),
        transforms.ToTensor(),
        transforms.Normalize(mean=MEAN, std=STD),
    ])


def transform_eval():
    return transforms.Compose([
        transforms.ToTensor(),
        transforms.Normalize(mean=MEAN, std=STD),
    ])


def weighted_sampler(samples: list[PairSample]) -> WeightedRandomSampler:
    pos = sum(sample.label for sample in samples)
    neg = len(samples) - pos
    weights = [1.0 / (pos if sample.label else neg) for sample in samples]
    return WeightedRandomSampler(weights, num_samples=len(samples), replacement=True)


class SiameseMobileNetMatcher(nn.Module):
    def __init__(self, *, pretrained: bool = True, embedding_dim: int = 256):
        super().__init__()
        weights = models.MobileNet_V3_Small_Weights.IMAGENET1K_V1 if pretrained else None
        base = models.mobilenet_v3_small(weights=weights)
        self.features = base.features
        self.avgpool = base.avgpool
        feature_dim = base.classifier[0].in_features
        self.projection = nn.Sequential(
            nn.Linear(feature_dim, embedding_dim),
            nn.Hardswish(inplace=True),
            nn.Dropout(p=0.1),
            nn.Linear(embedding_dim, embedding_dim),
        )
        self.head = nn.Sequential(
            nn.Linear(embedding_dim * 4, embedding_dim),
            nn.Hardswish(inplace=True),
            nn.Dropout(p=0.15),
            nn.Linear(embedding_dim, 1),
        )

    def encode_half(self, image: torch.Tensor) -> torch.Tensor:
        features = self.features(image)
        pooled = self.avgpool(features)
        flat = torch.flatten(pooled, 1)
        projected = self.projection(flat)
        return F.normalize(projected, dim=1)

    def forward(self, pair: torch.Tensor) -> torch.Tensor:
        prompt = pair[:, :, :, :CELL_SIZE]
        cell = pair[:, :, :, CELL_SIZE:]
        prompt_embedding = self.encode_half(prompt)
        cell_embedding = self.encode_half(cell)
        features = torch.cat([
            prompt_embedding,
            cell_embedding,
            torch.abs(prompt_embedding - cell_embedding),
            prompt_embedding * cell_embedding,
        ], dim=1)
        return self.head(features)


def make_pair_model(*, pretrained: bool = True) -> nn.Module:
    weights = models.MobileNet_V3_Small_Weights.IMAGENET1K_V1 if pretrained else None
    model = models.mobilenet_v3_small(weights=weights)
    in_features = model.classifier[-1].in_features
    model.classifier[-1] = nn.Linear(in_features, 1)
    return model


def make_model(arch: str = "pair", *, pretrained: bool = True, embedding_dim: int = 256) -> nn.Module:
    if arch == "pair":
        return make_pair_model(pretrained=pretrained)
    if arch == "siamese":
        return SiameseMobileNetMatcher(pretrained=pretrained, embedding_dim=embedding_dim)
    raise ValueError(f"unknown arch: {arch}")


def self_test() -> int:
    torch.manual_seed(20260710)
    transparent_prompt = Image.new("RGBA", (8, 8), (0, 0, 0, 0))
    for x in range(2, 6):
        transparent_prompt.putpixel((x, 4), (0, 0, 0, 255))
        transparent_prompt.putpixel((4, x), (0, 0, 0, 255))
    composited = np.array(prompt_to_rgb(transparent_prompt))
    if composited.mean() <= 200 or composited.min() != 0 or composited.max() != 255:
        raise AssertionError("transparent prompt was not composited as black-on-white")
    print("prompt_alpha_composite=ok")
    for arch in ("pair", "siamese"):
        model = make_model(arch=arch, pretrained=False).eval()
        x = torch.randn(2, 3, PAIR_HEIGHT, PAIR_WIDTH)
        with torch.inference_mode():
            logits = model(x)
        print(f"arch={arch} logit_shape={tuple(logits.shape)}")
        if tuple(logits.shape) != (2, 1):
            raise AssertionError(f"{arch} produced {tuple(logits.shape)}")
    with tempfile.TemporaryDirectory() as tmp_dir:
        onnx_path = Path(tmp_dir) / "nine_match_siamese.onnx"
        model = make_model(arch="siamese", pretrained=False).eval()
        export_onnx(model, onnx_path, torch.device("cpu"))
        session = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
        x = torch.randn(2, 3, PAIR_HEIGHT, PAIR_WIDTH)
        torch_result = model(x).detach().numpy()
        result = session.run(["logit"], {"input": x.numpy()})[0]
        if tuple(result.shape) != (2, 1):
            raise AssertionError(f"onnx produced {tuple(result.shape)}")
        print("onnx_export=ok arch=siamese")
        max_diff = float(np.max(np.abs(torch_result - result)))
        if max_diff > 1e-3:
            raise AssertionError(f"onnx parity failed for self-test: max_diff={max_diff:.6f}")
        print("onnx_parity=ok arch=siamese")
    print("self_test=ok")
    return 0


@torch.inference_mode()
def binary_accuracy(model: nn.Module, loader: DataLoader, device: torch.device) -> float:
    model.eval()
    good = 0
    total = 0
    for x, y in loader:
        x = x.to(device)
        y = y.to(device)
        pred = (torch.sigmoid(model(x)) >= 0.5).float()
        good += int((pred == y).sum().item())
        total += int(y.numel())
    return good / max(total, 1)


@torch.inference_mode()
def challenge_topk_accuracy(model: nn.Module, samples: list[PairSample], transform, device: torch.device) -> float:
    model.eval()
    by_challenge: dict[str, list[PairSample]] = {}
    for sample in samples:
        by_challenge.setdefault(sample.challenge_id, []).append(sample)
    good = 0
    for challenge_samples in by_challenge.values():
        expected = {(sample.row, sample.col) for sample in challenge_samples if sample.label}
        scored: list[tuple[float, tuple[int, int]]] = []
        for sample in challenge_samples:
            tensor = transform(make_pair_image(sample)).unsqueeze(0).to(device)
            score = float(torch.sigmoid(model(tensor)).cpu().item())
            scored.append((score, (sample.row, sample.col)))
        predicted = {cell for _, cell in sorted(scored, reverse=True)[:len(expected)]}
        if predicted == expected:
            good += 1
    return good / max(len(by_challenge), 1)


def export_onnx(model: nn.Module, output: Path, device: torch.device):
    model.eval()
    dummy = torch.zeros(1, 3, PAIR_HEIGHT, PAIR_WIDTH, device=device)
    output.parent.mkdir(parents=True, exist_ok=True)
    export_args = {
        "input_names": ["input"],
        "output_names": ["logit"],
        "opset_version": 17,
        "dynamic_axes": {"input": {0: "batch"}, "logit": {0: "batch"}},
    }
    with warnings.catch_warnings():
        warnings.filterwarnings(
            "ignore",
            message="You are using the legacy TorchScript-based ONNX export.*",
            category=DeprecationWarning,
        )
        try:
            torch.onnx.export(model, dummy, output, dynamo=False, **export_args)
        except TypeError:
            torch.onnx.export(model, dummy, output, **export_args)


@torch.inference_mode()
def verify_onnx_parity(model: nn.Module, onnx_path: Path, samples: list[PairSample], transform, device: torch.device):
    chosen = samples[:min(50, len(samples))]
    if not chosen:
        raise ValueError("no samples available for ONNX parity")
    original_device = next(model.parameters()).device
    model = model.to(torch.device("cpu"))
    session = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    try:
        for sample in chosen:
            tensor = transform(make_pair_image(sample)).unsqueeze(0)
            torch_logit = float(model(tensor).cpu().numpy()[0][0])
            onnx_logit = float(session.run(["logit"], {"input": tensor.numpy()})[0][0][0])
            if abs(torch_logit - onnx_logit) > 1e-3:
                raise AssertionError(f"ONNX parity failed for {sample.challenge_id}:{sample.row},{sample.col}")
    finally:
        model.to(original_device)
    print(f"onnx_parity=ok samples={len(chosen)}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--raw", default="dataset/raw")
    parser.add_argument("--labels", default="dataset/manual-labels.jsonl")
    parser.add_argument("--out-model", default="assets/captcha/nine_match.onnx")
    parser.add_argument("--out-meta", default="assets/captcha/nine_match.json")
    parser.add_argument("--arch", choices=["pair", "siamese"], default="pair")
    parser.add_argument("--embedding-dim", type=int, default=256)
    parser.add_argument("--epochs", type=int, default=18)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--lr", type=float, default=2e-4)
    parser.add_argument("--seed", type=int, default=20260710)
    parser.add_argument("--min-challenge-acc", type=float, default=0.60)
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    args = parser.parse_args()
    if args.self_test:
        return self_test()

    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    samples = collect_samples(Path(args.raw), Path(args.labels))
    train, val, test = split_by_challenge(samples, args.seed)
    device = torch.device(args.device)
    print(f"samples={len(samples)} train={len(train)} val={len(val)} test={len(test)} device={device}")

    train_ds = NineMatchDataset(train, transform_train())
    val_ds = NineMatchDataset(val, transform_eval())
    train_loader = DataLoader(train_ds, batch_size=args.batch_size, sampler=weighted_sampler(train), num_workers=0)
    val_loader = DataLoader(val_ds, batch_size=args.batch_size, shuffle=False, num_workers=0)

    model = make_model(arch=args.arch, embedding_dim=args.embedding_dim).to(device)
    pos = sum(sample.label for sample in train)
    neg = len(train) - pos
    if args.arch == "pair":
        loss_fn = nn.BCEWithLogitsLoss(pos_weight=torch.tensor([neg / max(pos, 1)], device=device))
        class_balance = "weighted_sampler_and_positive_loss_weight"
    else:
        loss_fn = nn.BCEWithLogitsLoss()
        class_balance = "weighted_sampler"
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    best_state = None
    best_score = -1.0
    eval_transform = transform_eval()

    for epoch in range(1, args.epochs + 1):
        model.train()
        losses: list[float] = []
        for x, y in train_loader:
            x = x.to(device)
            y = y.to(device)
            optimizer.zero_grad(set_to_none=True)
            loss = loss_fn(model(x), y)
            loss.backward()
            optimizer.step()
            losses.append(float(loss.detach().cpu()))
        val_binary = binary_accuracy(model, val_loader, device)
        val_topk = challenge_topk_accuracy(model, val, eval_transform, device)
        print(f"epoch={epoch} loss={np.mean(losses):.4f} val_binary={val_binary:.4f} val_challenge_topk={val_topk:.4f}")
        if val_topk > best_score:
            best_score = val_topk
            best_state = {key: value.detach().cpu() for key, value in model.state_dict().items()}

    if best_state is not None:
        model.load_state_dict(best_state)
    test_loader = DataLoader(NineMatchDataset(test, eval_transform), batch_size=args.batch_size, shuffle=False, num_workers=0)
    test_binary = binary_accuracy(model, test_loader, device)
    test_topk = challenge_topk_accuracy(model, test, eval_transform, device)
    print(f"heldout_binary={test_binary:.4f}")
    print(f"heldout_challenge_topk={test_topk:.4f}")
    if test_topk < args.min_challenge_acc:
        raise SystemExit(
            f"held-out challenge top-k below {args.min_challenge_acc:.2f}; "
            "keep artifacts for inspection only or collect more labels"
        )

    out_model = Path(args.out_model)
    out_meta = Path(args.out_meta)
    out_model.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        prefix=f"{out_model.stem}.",
        suffix=f".tmp{out_model.suffix}",
        dir=out_model.parent,
        delete=False,
    ) as tmp_file:
        temp_model = Path(tmp_file.name)
    try:
        export_onnx(model, temp_model, device)
        verify_onnx_parity(model, temp_model, test, eval_transform, device)
        temp_model.replace(out_model)
        out_meta.write_text(json.dumps({
            "kind": "nine_match_pair_binary",
            "input": {
                "width": PAIR_WIDTH,
                "height": PAIR_HEIGHT,
                "channels": 3,
                "layout": "prompt_64x64_left_cell_64x64_right",
                "mean": MEAN,
                "std": STD,
            },
            "training": {
                "arch": args.arch,
                "embeddingDim": args.embedding_dim if args.arch == "siamese" else None,
                "classBalance": class_balance,
                "sourceRaw": str(Path(args.raw)),
                "sourceLabels": str(Path(args.labels)),
                "seed": args.seed,
                "samples": len(samples),
                "trainSamples": len(train),
                "valSamples": len(val),
                "testSamples": len(test),
                "epochs": args.epochs,
                "heldoutBinary": test_binary,
                "heldoutChallengeTopk": test_topk,
            },
        }, indent=2), encoding="utf-8")
    finally:
        temp_model.unlink(missing_ok=True)
    print(f"wrote_model={out_model}")
    print(f"wrote_meta={out_meta}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
