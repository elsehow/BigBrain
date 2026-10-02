"""A local intake-firewall endpoint: Cloudflare's Clef-flash on Apple
silicon, answering the Jev/SystemOne `POST /v1/systemone` API that
lib/firewall.ts speaks.

The backbone runs 8-bit in MLX and hands its last hidden state to the
release's own joint schema head (torch, CPU). The model loads on the first
request and unloads after it sits idle, so it holds ~9 GB only while mail is
being screened. It binds 127.0.0.1: nothing off this machine can reach it,
and it needs no token.

    python clef_server.py --model-dir ~/.local/share/bigbrain/clef-flash

`setup.sh` beside this file builds the model directory. README.md has the rest.
"""

from __future__ import annotations

import argparse
import gc
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class Clef:
    """The loaded model, or nothing. One request at a time."""

    def __init__(self, model_dir: Path, idle_seconds: float) -> None:
        self.model_dir = model_dir
        self.idle_seconds = idle_seconds
        self.lock = threading.Lock()
        self.loaded: dict | None = None
        self.last_used = 0.0
        sys.path.insert(0, str(model_dir / "head"))
        threading.Thread(target=self._reaper, daemon=True).start()

    def _load(self) -> dict:
        import mlx.core as mx
        import numpy as np
        import torch
        from joint_schema_model import JointSchemaHead
        from mlx_lm import load
        from safetensors import safe_open
        from transformers import AutoTokenizer

        started = time.time()
        mlx_dir = self.model_dir / "mlx-q8"
        model, _ = load(str(mlx_dir))
        head = JointSchemaHead(**json.loads((self.model_dir / "head" / "joint_head_config.json").read_text()))
        with safe_open(str(self.model_dir / "head" / "joint_head.safetensors"), "pt") as f:
            head.load_state_dict({k: f.get_tensor(k) for k in f.keys()}, strict=True)
        lm_head = model.language_model.lm_head

        class Rows:
            """The head reads output-embedding rows only for option tokens;
            dequantize just those rows of the 8-bit lm_head."""

            def __getitem__(self, ids):
                idx = mx.array(ids.tolist())
                rows = mx.dequantize(
                    lm_head.weight[idx], lm_head.scales[idx], lm_head.biases[idx],
                    group_size=lm_head.group_size, bits=lm_head.bits,
                )
                return torch.from_numpy(np.array(rows.astype(mx.float32)))

        print(f"clef: loaded in {time.time() - started:.1f}s", file=sys.stderr, flush=True)
        return {
            "backbone": model.language_model.model,
            "tokenizer": AutoTokenizer.from_pretrained(str(mlx_dir)),
            "head": head.float().eval(),
            "rows": Rows(),
            "model": model,
        }

    def _reaper(self) -> None:
        while True:
            time.sleep(30)
            with self.lock:
                if self.loaded and time.time() - self.last_used > self.idle_seconds:
                    self.loaded = None
                    gc.collect()
                    import mlx.core as mx

                    mx.clear_cache()
                    print("clef: idle, unloaded", file=sys.stderr, flush=True)

    def answer(self, request: dict) -> dict:
        import mlx.core as mx
        import numpy as np
        import torch
        from joint_schema_model import QUESTION_TYPES, encode_record, systemone_answer

        questions = request.get("questions")
        if "state" not in request or not isinstance(questions, dict) or not questions:
            raise ValueError("state and at least one question are required")
        for qid, q in questions.items():
            if not isinstance(q, dict) or q.get("type") not in QUESTION_TYPES:
                raise ValueError(f"{qid}: type must be noul, choice, or score")
            if q["type"] != "noul" and not q.get("criteria"):
                raise ValueError(f"{qid}: criteria must not be empty")
        with self.lock:
            if self.loaded is None:
                self.loaded = self._load()
            m = self.loaded
            enc = encode_record(m["tokenizer"], {"state": request["state"], "questions": questions})
            hidden = m["backbone"](mx.array([list(enc.input_ids)]))
            mx.eval(hidden)
            hidden_t = torch.from_numpy(np.array(hidden.astype(mx.float32)))
            ids = torch.tensor([list(enc.input_ids)])
            with torch.inference_mode():
                logits = m["head"](hidden_t, ids, torch.ones_like(ids), [enc], m["rows"])[0]
            self.last_used = time.time()
        answers = {
            q.question_id: systemone_answer(questions[q.question_id], dict(zip(q.option_ids, lg.float().softmax(-1).tolist())))
            for q, lg in zip(enc.questions, logits)
        }
        return {
            "model": str(request.get("model", "clef-flash")),
            "answers": answers,
            "usage": {"input_tokens": len(enc.input_ids), "output_tokens": 0},
        }


def serve(clef: Clef, port: int) -> None:
    class Handler(BaseHTTPRequestHandler):
        def _send(self, status: int, body: dict) -> None:
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self) -> None:
            if self.path == "/health":
                self._send(200, {"ok": True, "loaded": clef.loaded is not None})
            else:
                self._send(404, {"error": "not found"})

        def do_POST(self) -> None:
            if self.path != "/v1/systemone":
                return self._send(404, {"error": "not found"})
            try:
                request = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)))
                if not isinstance(request, dict):
                    raise ValueError("body must be a JSON object")
            except ValueError as e:
                return self._send(400, {"error": str(e)})
            try:
                self._send(200, clef.answer(request))
            except ValueError as e:
                self._send(400, {"error": str(e)})
            except Exception as e:  # the engine fails closed on any 5xx
                print(f"clef: {e!r}", file=sys.stderr, flush=True)
                self._send(500, {"error": "inference failed"})

        def log_message(self, *_args) -> None:
            pass  # never log request bodies or paths with content

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"clef: listening on http://127.0.0.1:{port}/v1/systemone", file=sys.stderr, flush=True)
    server.serve_forever()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--model-dir", type=Path, default=Path.home() / ".local/share/bigbrain/clef-flash")
    parser.add_argument("--port", type=int, default=4750)
    parser.add_argument("--idle-minutes", type=float, default=10)
    args = parser.parse_args()
    serve(Clef(args.model_dir.expanduser(), args.idle_minutes * 60), args.port)
