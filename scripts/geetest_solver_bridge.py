import sys
import json
import os

BRIDGE_DIR = os.path.dirname(os.path.abspath(__file__))
SOLVER_DIR = os.path.join(BRIDGE_DIR, "..", "GeekedTest-main")

sys.path.insert(0, SOLVER_DIR)

# Limita as threads das libs nativas (OpenMP/MKL/BLAS) ANTES de importar torch
# via geeked -> impede que o CLIP (CPU) monopolize os cores e trave os
# navegadores concorrentes. Override via SPIDER_SOLVER_THREADS (default 2).
_solver_threads = os.environ.get("SPIDER_SOLVER_THREADS", "2")
for _var in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS"):
    os.environ.setdefault(_var, _solver_threads)

from geeked import Geeked


def main():
    try:
        raw = sys.stdin.read()
        if not raw:
            print(json.dumps({"error": "No input received on stdin"}))
            sys.exit(1)

        params = json.loads(raw)

        captcha_id = params.get("captcha_id", "").strip()
        if not captcha_id:
            print(json.dumps({"error": "captcha_id is required"}))
            sys.exit(1)

        risk_type = params.get("risk_type") or None
        base_url = params.get("base_url") or "https://gcaptcha4.geevisit.com"
        proxy = params.get("proxy") or None
        verify = params.get("verify", True)
        max_retries = int(params.get("max_retries", 5))

        kwargs = {"base_url": base_url}
        if proxy:
            kwargs["proxy"] = proxy
        if not verify:
            kwargs["verify"] = False

        geeked = Geeked(captcha_id, risk_type, **kwargs)
        seccode = geeked.solve(max_retries=max_retries)

        print(json.dumps(seccode))
        sys.exit(0)

    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
