from __future__ import annotations

import argparse
import json
import random
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch
from PIL import Image
from torch import nn
from torch.utils.data import DataLoader, Dataset, WeightedRandomSampler
from torchvision import models, transforms

MEAN = [0.485, 0.456, 0.406]
STD = [0.229, 0.224, 0.225]


@dataclass(frozen=True)
class Sample:
    path: Path
    label: int


class NinePhotoDataset(Dataset):
    def __init__(self, samples: list[Sample], transform: transforms.Compose):
        self.samples = samples
        self.transform = transform

    def __len__(self) -> int:
        return len(self.samples)

    def __getitem__(self, idx: int):
        sample = self.samples[idx]
        image = Image.open(sample.path).convert("RGB")
        return self.transform(image), sample.label


def load_classes(path: Path) -> list[str]:
    data = json.loads(path.read_text(encoding="utf-8"))
    classes = data.get("charset", data)
    if not isinstance(classes, list) or len(classes) != 40:
        raise ValueError(f"{path} must contain 40 classes")
    return [str(c) for c in classes]


def collect_samples(data_root: Path, classes: list[str]) -> list[Sample]:
    class_to_idx = {name: idx for idx, name in enumerate(classes)}
    samples: list[Sample] = []
    for cls in classes:
        for path in sorted((data_root / cls).glob("*.jpg")):
            samples.append(Sample(path=path, label=class_to_idx[cls]))
    if not samples:
        raise ValueError(f"no jpg samples found under {data_root}")
    return samples


def stratified_split(samples: list[Sample], seed: int):
    by_class: dict[int, list[Sample]] = {}
    for sample in samples:
        by_class.setdefault(sample.label, []).append(sample)
    rng = random.Random(seed)
    train: list[Sample] = []
    val: list[Sample] = []
    test: list[Sample] = []
    for cls_samples in by_class.values():
        rng.shuffle(cls_samples)
        n = len(cls_samples)
        n_test = max(1, round(n * 0.10))
        n_val = max(1, round(n * 0.10))
        test.extend(cls_samples[:n_test])
        val.extend(cls_samples[n_test:n_test + n_val])
        train.extend(cls_samples[n_test + n_val:])
    return train, val, test


def make_model(num_classes: int) -> nn.Module:
    weights = models.MobileNet_V3_Small_Weights.IMAGENET1K_V1
    model = models.mobilenet_v3_small(weights=weights)
    in_features = model.classifier[-1].in_features
    model.classifier[-1] = nn.Linear(in_features, num_classes)
    return model


def transforms_for_train():
    return transforms.Compose([
        transforms.Resize((64, 64), interpolation=transforms.InterpolationMode.BILINEAR, antialias=True),
        transforms.ColorJitter(brightness=0.18, contrast=0.18, saturation=0.18),
        transforms.RandomAffine(degrees=0, translate=(0.06, 0.06), scale=(0.92, 1.08)),
        transforms.ToTensor(),
        transforms.Normalize(mean=MEAN, std=STD),
    ])


def transforms_for_eval():
    return transforms.Compose([
        transforms.Resize((64, 64), interpolation=transforms.InterpolationMode.BILINEAR, antialias=True),
        transforms.ToTensor(),
        transforms.Normalize(mean=MEAN, std=STD),
    ])


def weighted_sampler(samples: list[Sample]) -> WeightedRandomSampler:
    counts: dict[int, int] = {}
    for sample in samples:
        counts[sample.label] = counts.get(sample.label, 0) + 1
    weights = [1.0 / counts[sample.label] for sample in samples]
    return WeightedRandomSampler(weights, num_samples=len(samples), replacement=True)


@torch.inference_mode()
def accuracy(model: nn.Module, loader: DataLoader, device: torch.device) -> float:
    model.eval()
    good = 0
    total = 0
    for x, y in loader:
        x = x.to(device)
        y = y.to(device)
        pred = model(x).argmax(dim=1)
        good += int((pred == y).sum().item())
        total += int(y.numel())
    return good / max(total, 1)


def export_onnx(model: nn.Module, output: Path, device: torch.device):
    model.eval()
    dummy = torch.zeros(1, 3, 64, 64, device=device)
    output.parent.mkdir(parents=True, exist_ok=True)
    torch.onnx.export(
        model,
        dummy,
        output,
        input_names=["input"],
        output_names=["logits"],
        opset_version=17,
        dynamic_axes={"input": {0: "batch"}, "logits": {0: "batch"}},
    )


@torch.inference_mode()
def verify_onnx_parity(model: nn.Module, onnx_path: Path, samples: list[Sample], transform, device: torch.device):
    session = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    chosen = samples[:50]
    for sample in chosen:
        tensor = transform(Image.open(sample.path).convert("RGB")).unsqueeze(0)
        torch_logits = model(tensor.to(device)).cpu().numpy()[0]
        onnx_logits = session.run(["logits"], {"input": tensor.numpy()})[0][0]
        if int(torch_logits.argmax()) != int(onnx_logits.argmax()):
            raise AssertionError(f"argmax parity failed for {sample.path}")
        if set(np.argsort(torch_logits)[-5:]) != set(np.argsort(onnx_logits)[-5:]):
            raise AssertionError(f"top5 parity failed for {sample.path}")
    print(f"onnx_parity=ok samples={len(chosen)}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", default="dataset/labeled")
    parser.add_argument("--classes", default="assets/captcha/charsets.json")
    parser.add_argument("--out-model", default="assets/captcha/nine_photo.onnx")
    parser.add_argument("--out-classes", default="assets/captcha/nine_classes.json")
    parser.add_argument("--epochs", type=int, default=12)
    parser.add_argument("--batch-size", type=int, default=128)
    parser.add_argument("--lr", type=float, default=3e-4)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    args = parser.parse_args()

    random.seed(args.seed)
    torch.manual_seed(args.seed)
    classes = load_classes(Path(args.classes))
    samples = collect_samples(Path(args.data), classes)
    train, val, test = stratified_split(samples, args.seed)
    device = torch.device(args.device)

    train_ds = NinePhotoDataset(train, transforms_for_train())
    val_ds = NinePhotoDataset(val, transforms_for_eval())
    test_ds = NinePhotoDataset(test, transforms_for_eval())
    train_loader = DataLoader(train_ds, batch_size=args.batch_size, sampler=weighted_sampler(train), num_workers=2)
    val_loader = DataLoader(val_ds, batch_size=args.batch_size, shuffle=False, num_workers=2)
    test_loader = DataLoader(test_ds, batch_size=args.batch_size, shuffle=False, num_workers=2)

    model = make_model(len(classes)).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    loss_fn = nn.CrossEntropyLoss()
    best_state = None
    best_val = -1.0
    for epoch in range(1, args.epochs + 1):
        model.train()
        for x, y in train_loader:
            x = x.to(device)
            y = y.to(device)
            optimizer.zero_grad(set_to_none=True)
            loss = loss_fn(model(x), y)
            loss.backward()
            optimizer.step()
        val_acc = accuracy(model, val_loader, device)
        print(f"epoch={epoch} val_acc={val_acc:.4f}")
        if val_acc > best_val:
            best_val = val_acc
            best_state = {k: v.detach().cpu() for k, v in model.state_dict().items()}
    if best_state is not None:
        model.load_state_dict(best_state)
    test_acc = accuracy(model, test_loader, device)
    print(f"heldout_top1={test_acc:.4f}")
    if test_acc < 0.90:
        raise SystemExit("held-out top1 below 0.90; collect/review more data before exporting")
    export_onnx(model, Path(args.out_model), device)
    Path(args.out_classes).write_text(json.dumps({
        "charset": classes,
        "input": {"width": 64, "height": 64, "channels": 3, "mean": MEAN, "std": STD, "resize": "bilinear"},
        "source": "Plan 2c MobileNetV3-Small ImageNet fine-tune",
    }, indent=2), encoding="utf-8")
    verify_onnx_parity(model, Path(args.out_model), test, transforms_for_eval(), device)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
