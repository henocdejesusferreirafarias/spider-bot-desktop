#https://github.com/glizzykingdreko/Datadome-GeeTest-Captcha-Solver/blob/main/solver.py
"""
MIT LICENSE

Big thanks to glizzykingdreko for making amazing solver

i modified it a bit
"""
import numpy as np
import requests, cv2


class SlideSolver:
    def __init__(self, puzzle_piece, background):
        self.background = self._read_image(background)
        self.puzzle_piece = self._read_image(puzzle_piece)

    @staticmethod
    def test():
        identifier = SlideSolver(
            background=SlideSolver.load_image("https://static.geetest.com/captcha_v4/e70fbf1d77/slide/0af8d91d43/2022-04-21T09/bg/552119bd2af448b9a3af1ce95b887b90.png"),
            puzzle_piece=SlideSolver.load_image("https://static.geetest.com/captcha_v4/e70fbf1d77/slide/0af8d91d43/2022-04-21T09/slice/552119bd2af448b9a3af1ce95b887b90.png"),
        )
        result = identifier.find_puzzle_piece_position()
        print(f"Result: {result}")

    @staticmethod
    def load_image(url: str) -> np.ndarray:
        response = requests.get(url)
        return response.content

    @staticmethod
    def _read_image(image_source):
        """
        Read an image from a file or a requests response object.
        """
        if isinstance(image_source, bytes):
            return cv2.imdecode(np.frombuffer(image_source, np.uint8), cv2.IMREAD_ANYCOLOR)
        elif hasattr(image_source, 'read'):  # Checks if it's a file-like object
            return cv2.imdecode(np.frombuffer(image_source.read(), np.uint8), cv2.IMREAD_ANYCOLOR)
        else:
            raise TypeError("Invalid image source type. Must be bytes or a file-like object.")

    def _match(self, template, background):
        """Run a normalized template match and return (peak_score, top_left, (h, w))."""
        res = cv2.matchTemplate(background, template, cv2.TM_CCOEFF_NORMED)
        _, max_val, _, max_loc = cv2.minMaxLoc(res)
        h, w = template.shape[:2]
        return float(max_val), max_loc, (h, w)

    def find_puzzle_piece_position(self):
        """
        Find the matching position of a puzzle piece in a background image.

        Robustez: a deteccao por bordas (Canny) falha em fundos de baixo contraste,
        entao tentamos tambem o match direto em tons de cinza e ficamos com o
        resultado de maior confianca.
        """
        candidates = []

        # 1) Match por bordas (bom para fundos texturizados).
        edge_piece = cv2.cvtColor(cv2.Canny(self.puzzle_piece, 100, 200), cv2.COLOR_GRAY2RGB)
        edge_bg = cv2.cvtColor(cv2.Canny(self.background, 100, 200), cv2.COLOR_GRAY2RGB)
        candidates.append(self._match(edge_piece, edge_bg))

        # 2) Match direto em tons de cinza (bom para fundos de baixo contraste).
        gray_piece = cv2.cvtColor(self.puzzle_piece, cv2.COLOR_BGR2GRAY)
        gray_bg = cv2.cvtColor(self.background, cv2.COLOR_BGR2GRAY)
        candidates.append(self._match(gray_piece, gray_bg))

        score, top_left, (h, w) = max(candidates, key=lambda c: c[0])
        center_x = top_left[0] + w // 2

        return center_x - 41  # -41 because we need the start of the piece, not the center


if __name__ == '__main__':
    SlideSolver.test()