# clip-burn.py — reproduz a carga de CPU do captcha solver REAL (CLIP ViT-B-32) para
# medir seu impacto nos navegadores. Faz o warmup do modelo (como beginWarmSession ->
# warmup_models) e entao um loop de inferencias (como solves em sequencia no painel).
# Uso: python clip-burn.py [segundos]   (default 30)
import os, sys, time, io
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
# mesma resolucao do geetest_solver_worker.py: scripts/../GeekedTest-main
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "GeekedTest-main"))

duration = float(sys.argv[1]) if len(sys.argv) > 1 else 30.0


def log(msg):
    print(f"[clip-burn t={time.time()-T0:5.1f}s] {msg}", flush=True)


T0 = time.time()
import torch  # noqa
log(f"torch threads={torch.get_num_threads()} cores={os.cpu_count()}")
from geeked.clip_shared import ensure_clip, classify_direction
import numpy as np
from PIL import Image

log("warmup ensure_clip() ...")
ensure_clip()
log("warmup DONE")

buf = io.BytesIO()
Image.fromarray((np.random.rand(60, 60, 3) * 255).astype("uint8")).save(buf, "PNG")
img = buf.getvalue()

n = 0
end = time.time() + duration
while time.time() < end:
    classify_direction(img)
    n += 1
log(f"inferencias={n} em loop continuo")
