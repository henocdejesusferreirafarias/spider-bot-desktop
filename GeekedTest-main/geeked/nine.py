import cv2
import numpy as np
import requests
import time
import warnings
from io import BytesIO
from PIL import Image
from typing import List


class NineSolver:
    _ready = False

    def __init__(self, imgs: str, ques: List[str], nine_nums: int = 3):
        self.grid_img = self.load_image(f'https://static.geetest.com/{imgs}')
        self.ques_urls = ques
        self.nine_nums = nine_nums

    @staticmethod
    def load_image(url: str) -> bytes:
        response = requests.get(url, timeout=10)
        response.raise_for_status()
        return response.content

    @classmethod
    def _ensure(cls):
        if cls._ready:
            return
        from .clip_shared import ensure_clip
        ensure_clip()
        cls._ready = True

    def _rgba_to_rgb(self, rgba_bytes: bytes) -> np.ndarray:
        img = Image.open(BytesIO(rgba_bytes)).convert('RGBA')
        rgba = np.array(img).astype(np.float32) / 255.0
        rgb = rgba[:, :, :3]
        alpha = rgba[:, :, 3:4]
        composited = rgb * alpha + np.ones_like(rgb) * (1.0 - alpha)
        return (composited * 255).astype(np.uint8)

    def find_icon_positions(self) -> List[List[int]]:
        self._ensure()
        from .clip_shared import encode_images

        grid_bgr = cv2.imdecode(np.frombuffer(self.grid_img, np.uint8), cv2.IMREAD_COLOR)
        if grid_bgr is None:
            raise ValueError("Failed to decode grid image")
        grid_rgb = cv2.cvtColor(grid_bgr, cv2.COLOR_BGR2RGB)
        h, w = grid_rgb.shape[:2]
        cell_w, cell_h = w // 3, h // 3

        if not self.ques_urls:
            raise ValueError("No question icons provided")
        ques_bytes = self.load_image(f'https://static.geetest.com/{self.ques_urls[0]}')
        ques_rgb = self._rgba_to_rgb(ques_bytes)

        cells = []
        for row in range(3):
            for col in range(3):
                cells.append(grid_rgb[row*cell_h:(row+1)*cell_h, col*cell_w:(col+1)*cell_w])

        t0 = time.time()

        all_images = [ques_rgb] + cells
        all_embs = encode_images(all_images)
        query_emb = all_embs[0]
        cell_embs = all_embs[1:]
        similarities = (cell_embs @ query_emb.T).flatten()

        elapsed = time.time() - t0

        scores = [(float(similarities[i]), i // 3, i % 3) for i in range(9)]
        scores.sort(key=lambda x: -x[0])

        results = []
        for sim, row, col in scores[:self.nine_nums]:
            results.append([row + 1, col + 1])

        if elapsed > 3.0:
            warnings.warn(f"NineSolver inference took {elapsed:.1f}s (target: <3s)")

        return results
