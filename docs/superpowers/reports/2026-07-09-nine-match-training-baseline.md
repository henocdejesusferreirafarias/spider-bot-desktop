# Nine Match Training Baseline

Date: 2026-07-09

## Input

- Raw challenges: `dataset/raw` with 192 challenges.
- Manual labels: `dataset/manual-labels.jsonl`.
- Final labels validated before training:
  - 384 round labels.
  - 192 final labels.
  - 0 skipped challenges.
  - 0 unresolved disputes.

## Approach

Created `scripts/captcha-train-nine-match.py`, a supervised pairwise baseline:

- Builds 9 samples per challenge: `(ques.png, grid cell) -> match / non-match`.
- Uses challenge-level train/validation/test split to avoid leakage.
- Pair image layout: prompt resized to 64x64 on the left, candidate cell resized to 64x64 on the right.
- Model: ImageNet-pretrained MobileNetV3-Small with a binary logit head.
- Runtime artifacts would be `assets/captcha/nine_match.onnx` and `assets/captcha/nine_match.json` only if holdout challenge top-k passes the configured threshold.

## Results

Short run:

```text
epochs=18
heldout_binary=0.5900
heldout_challenge_topk=0.2069
```

Longer run:

```text
epochs=60
heldout_binary=0.6360
heldout_challenge_topk=0.1379
```

The export threshold was `heldout_challenge_topk >= 0.60`, so no production model artifact was exported.

## Decision

Do not wire a trained model into the runtime yet.

The 192-label corpus is enough to validate the training pipeline, but not enough to produce a reliable visual matching model for arbitrary GeeTest `nine` photo challenges.

## Next Step

Collect and label more challenges, then rerun:

```bash
npm run train:nine-match -- --epochs 60 --batch-size 64 --lr 0.00015 --min-challenge-acc 0.60
```

Consider at least 1,000 labeled challenges before expecting stable generalization.
