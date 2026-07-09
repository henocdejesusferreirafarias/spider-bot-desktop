"""Oracle ddddocr-exato para o ques fixture.

ddddocr.classification() retorna None para modelos `word: true` (branch sem
return — bug conhecido). Este script replica o preprocessing INTERNO do
ddddocr (PIL resize 64x64 ANTIALIAS + convert('L') + (x/255-0.456)/0.224 +
onnx run input1 + charset[argmax(output '63')]) que e a verdadeira saida .py.
Tambem computa o label via pipeline cv (COLOR_RGBA2GRAY + INTER_AREA) que e o
que o TS implementa, para conciliacao.
"""
import json
import sys
import numpy as np
import onnxruntime as ort
from PIL import Image

MODEL = 'assets/captcha/geetest_v4_icon.onnx'
CHARSETS = 'assets/captcha/charsets.json'
IMG = sys.argv[1] if len(sys.argv) > 1 else 'test/fixtures/captcha/nine/ques.png'

with open(CHARSETS, 'r', encoding='utf-8') as f:
    info = json.load(f)
charset = info['charset']
word = info['word']
resize_info = info['image']
channel = info['channel']

sess = ort.InferenceSession(MODEL, providers=['CPUExecutionProvider'])

# --- ddddocr internal PIL preprocessing (faithful to ddddocr.classification) ---
im = Image.open(IMG)
if resize_info[0] == -1:
    if word:
        im = im.resize((resize_info[1], resize_info[1]), Image.LANCZOS)
    else:
        im = im.resize((int(im.size[0] * (resize_info[1] / im.size[1])), resize_info[1]), Image.LANCZOS)
else:
    im = im.resize((resize_info[0], resize_info[1]), Image.LANCZOS)
if channel == 1:
    im = im.convert('L')
else:
    im = im.convert('RGB')
arr = np.array(im).astype(np.float32)
arr = np.expand_dims(arr, axis=0) / 255.0
if channel == 1:
    arr = (arr - 0.456) / 0.224
arr = np.array([arr]).astype(np.float32)
outs = sess.run(None, {'input1': arr})
# outputs: [output (logits), '63' (argmax)]
pil_argmax = int(np.array(outs[1]).flatten()[0])
pil_label = charset[pil_argmax]

# --- cv pipeline (what onnx-session.ts implements) ---
try:
    import cv2
    raw = np.frombuffer(open(IMG, 'rb').read(), np.uint8)
    cvimg = cv2.imdecode(raw, cv2.IMREAD_UNCHANGED)
    if cvimg.shape[2] == 4:
        gray = cv2.cvtColor(cvimg, cv2.COLOR_RGBA2GRAY)
    else:
        gray = cv2.cvtColor(cvimg, cv2.COLOR_BGR2GRAY)
    r = cv2.resize(gray, (64, 64), interpolation=cv2.INTER_AREA)
    a = (r.astype(np.float32) / 255.0 - 0.456) / 0.224
    a = a.reshape(1, 1, 64, 64).astype(np.float32)
    o2 = sess.run(None, {'input1': a})
    cv_argmax = int(np.array(o2[1]).flatten()[0])
    cv_label = charset[cv_argmax]
except Exception as e:
    cv_label = f'CV_ERR: {e}'
    cv_argmax = -1

print(json.dumps({
    'pil_label': pil_label,
    'pil_argmax': pil_argmax,
    'cv_label': cv_label,
    'cv_argmax': cv_argmax,
    'match': pil_label == cv_label,
}, ensure_ascii=False))
