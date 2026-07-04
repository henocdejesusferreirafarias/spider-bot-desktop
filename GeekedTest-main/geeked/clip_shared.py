import os
import torch
import open_clip
import warnings

# O solver de captcha (CLIP ViT-B-32) roda na CPU concorrente com varios
# navegadores. Por padrao o torch abre 1 thread por core fisico (ex.: 10 threads
# em 16 cores) e monopoliza a CPU: medimos a prontidao das telas degradando 2-4x
# e o jank da main-thread ~3.5x quando o solver esta ativo. Limitar as threads
# recupera a maior parte dessa perda. Override via SPIDER_SOLVER_THREADS.
_SOLVER_THREADS = max(1, int(os.environ.get("SPIDER_SOLVER_THREADS") or "2"))
try:
    torch.set_num_threads(_SOLVER_THREADS)
except Exception:
    pass

_model = None
_preprocess = None
_tokenizer = None
_direction_embs = None
_ready = False

MODEL_NAME = 'ViT-B-32'
PRETRAINED = 'laion2b_s34b_b79k'

DIRECTION_PROMPTS = {
    'u':  "an icon pointing straight up",
    'd':  "an icon pointing straight down",
    'l':  "an icon pointing left",
    'r':  "an icon pointing right",
    'lu': "an icon pointing to the upper left",
    'ld': "an icon pointing to the lower left",
    'ru': "an icon pointing to the upper right",
    'rd': "an icon pointing to the lower right",
}
DIRECTIONS = list(DIRECTION_PROMPTS.keys())


def ensure_clip():
    global _model, _preprocess, _tokenizer, _direction_embs, _ready
    if _ready:
        return
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", message=".*unauthenticated.*")
        _model, _, _preprocess = open_clip.create_model_and_transforms(
            MODEL_NAME, pretrained=PRETRAINED
        )
    _model = _model.to('cpu').eval()
    _tokenizer = open_clip.get_tokenizer(MODEL_NAME)

    texts = list(DIRECTION_PROMPTS.values())
    tokens = _tokenizer(texts).to('cpu')
    with torch.inference_mode():
        embs = _model.encode_text(tokens)
        _direction_embs = embs / embs.norm(dim=-1, keepdim=True)
    _ready = True


def encode_image(img_rgb):
    ensure_clip()
    from PIL import Image
    pil = Image.fromarray(img_rgb)
    t = _preprocess(pil).unsqueeze(0).to('cpu')
    with torch.inference_mode():
        f = _model.encode_image(t)
        return (f / f.norm(dim=-1, keepdim=True)).cpu().numpy()


def encode_images(images_rgb):
    ensure_clip()
    from PIL import Image
    tensors = [_preprocess(Image.fromarray(img)).unsqueeze(0) for img in images_rgb]
    batch = torch.cat(tensors).to('cpu')
    with torch.inference_mode():
        f = _model.encode_image(batch)
        return (f / f.norm(dim=-1, keepdim=True)).cpu().numpy()


def classify_direction(img_bytes):
    ensure_clip()
    from PIL import Image
    from io import BytesIO
    img = Image.open(BytesIO(img_bytes)).convert('RGB')
    t = _preprocess(img).unsqueeze(0).to('cpu')
    with torch.inference_mode():
        f = _model.encode_image(t)
        f = f / f.norm(dim=-1, keepdim=True)
        sims = (f @ _direction_embs.T).squeeze(0)
    return DIRECTIONS[int(sims.argmax().item())]
