#!/usr/bin/env bash
# Build the local Clef-flash model directory clef_server.py serves from:
# download the release (~19 GB), quantize the backbone to 8-bit MLX, keep the
# joint schema head, then delete the full-precision download. Needs Apple
# silicon, uv, ~30 GB free while it runs and ~10 GB after.
set -euo pipefail

DIR="${1:-$HOME/.local/share/bigbrain/clef-flash}"
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$DIR"
cd "$DIR"

[ -d .venv ] || uv venv -q --python 3.12 .venv
uv pip install -q --python .venv/bin/python -r "$HERE/requirements.txt"

if [ ! -d mlx-q8 ]; then
  uvx --from huggingface_hub hf download Cloudflare/clef-flash --local-dir release
  .venv/bin/python -m mlx_lm convert --hf-path release --mlx-path mlx-q8 -q --q-bits 8
  mkdir -p head
  cp release/{joint_schema_model.py,joint_head.safetensors,joint_head_config.json,LICENSE} head/
  rm -rf release
fi

echo "ready: $DIR"
echo "run:   $DIR/.venv/bin/python $HERE/clef_server.py --model-dir $DIR"
