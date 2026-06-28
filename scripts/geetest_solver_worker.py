import contextlib
import json
import os
import sys

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


PROTOCOL_OUT = sys.stdout


def write_message(message):
    PROTOCOL_OUT.write(json.dumps(message, separators=(",", ":")) + "\n")
    PROTOCOL_OUT.flush()


def warmup_models():
    try:
        from geeked.clip_shared import ensure_clip
        ensure_clip()
    except Exception as exc:
        print(f"warmup clip failed: {exc}", file=sys.stderr, flush=True)

    try:
        from geeked.dddd_server import dddd_service
        _ = dddd_service
    except Exception as exc:
        print(f"warmup dddd failed: {exc}", file=sys.stderr, flush=True)


def solve(params):
    captcha_id = (params.get("captcha_id") or "").strip()
    if not captcha_id:
        raise ValueError("captcha_id is required")

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
    return geeked.solve(max_retries=max_retries)


def main():
    with contextlib.redirect_stdout(sys.stderr):
        warmup_models()

    for line in sys.stdin:
        raw = line.strip()
        if not raw:
            continue

        try:
            message = json.loads(raw)
        except Exception as exc:
            write_message({"ok": False, "error": f"invalid json: {exc}"})
            continue

        request_id = message.get("id")
        if message.get("type") == "shutdown":
            write_message({"id": request_id, "ok": True, "type": "shutdown"})
            break

        try:
            with contextlib.redirect_stdout(sys.stderr):
                result = solve(message.get("payload") or {})
            write_message({"id": request_id, "ok": True, "result": result})
        except Exception as exc:
            write_message({"id": request_id, "ok": False, "error": str(exc)})


if __name__ == "__main__":
    main()
