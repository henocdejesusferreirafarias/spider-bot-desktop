import cv2
import numpy as np
import requests
from itertools import permutations
from typing import List


class IconSolver:
    def __init__(self, imgs: str, ques: List[str]):
        self.imgs = self.load_image(f'https://static.geetest.com/{imgs}')
        self.ques = ques

    @staticmethod
    def load_image(url: str) -> bytes:
        r = requests.get(url, timeout=10)
        r.raise_for_status()
        return r.content

    def _load_rgb(self, url: str) -> np.ndarray:
        buf = self.load_image(f'https://static.geetest.com/{url}')
        img = cv2.imdecode(np.frombuffer(buf, np.uint8), cv2.IMREAD_UNCHANGED)
        if img is None:
            raise ValueError("Failed to decode image")
        if len(img.shape) == 3 and img.shape[2] == 4:
            bgr = img[:, :, :3]
            alpha = img[:, :, 3:4].astype(np.float32) / 255.0
            img = (bgr.astype(np.float32) * alpha + 255.0 * (1.0 - alpha)).astype(np.uint8)
        return cv2.cvtColor(img, cv2.COLOR_BGR2RGB)

    def find_icon_position(self) -> List[List[float]]:
        from .dddd_server import dddd_service
        from .clip_shared import encode_images

        bboxes = dddd_service.detection(self.imgs)
        if not bboxes:
            return []

        im = cv2.imdecode(np.frombuffer(self.imgs, np.uint8), cv2.IMREAD_COLOR)
        if im is None:
            return []
        im_rgb = cv2.cvtColor(im, cv2.COLOR_BGR2RGB)
        img_h, img_w = im_rgb.shape[:2]

        scale_x = 33.0 if img_w == 300 else 10000.0 / img_w
        scale_y = 49.0 if img_h == 200 else 10000.0 / img_h

        ques_rgbs = []
        for q in self.ques:
            try:
                ques_rgbs.append(self._load_rgb(q))
            except Exception:
                pass
        if not ques_rgbs:
            return []
        n = len(ques_rgbs)

        crop_rgbs = []
        crop_centers = []

        for x1, y1, x2, y2 in bboxes:
            x1, y1 = max(0, x1), max(0, y1)
            x2, y2 = min(img_w, x2), min(img_h, y2)
            if x2 <= x1 or y2 <= y1:
                continue
            crop_rgbs.append(im_rgb[y1:y2, x1:x2])
            crop_centers.append(((x1 + x2) / 2.0, (y1 + y2) / 2.0))

        if len(crop_rgbs) < n:
            return []

        # CLIP matching
        all_images = ques_rgbs + crop_rgbs
        all_embs = encode_images(all_images)
        q_embs = all_embs[:n]
        c_embs = all_embs[n:]

        clip_sim = c_embs @ q_embs.T  # [n_crops, n_questions]

        # Hungarian assignment on CLIP similarity
        n_crops = len(crop_rgbs)
        cost = np.zeros((n, max(n, n_crops)))
        for qi in range(n):
            for ci in range(n_crops):
                cost[qi, ci] = float(clip_sim[ci, qi])
        cost = cost[:, :n]

        best_total = -999.0
        best_assign = None
        for perm in permutations(range(n)):
            total = sum(cost[i, perm[i]] for i in range(n))
            if total > best_total:
                best_total = total
                best_assign = perm

        if best_assign is None:
            return []

        results = []
        for qi in range(n):
            ci = best_assign[qi]
            cx, cy = crop_centers[ci]
            results.append([cx * scale_x, cy * scale_y])

        return results
