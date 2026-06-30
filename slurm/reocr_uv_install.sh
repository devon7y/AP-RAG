#!/bin/bash
# Runs INSIDE the python:3.12 Apptainer container. Uses uv (parallel, multiplexed
# downloads) instead of pip — pythonhosted throttles pip's single sequential
# connection to ~120 kB/s, but uv's concurrent downloads beat the per-connection cap.
set -e
R=/scratch/devon7y/reocr
export UV_CACHE_DIR=$R/uv_cache
source $R/cvenv/bin/activate
pip install -q uv
uv pip install infinity_parser2
python -c "import infinity_parser2 as ip; print('infinity_parser2', getattr(ip,'__version__','ok'))"
python -c "import vllm; print('vllm', vllm.__version__)"
echo CONTAINER_VENV_DONE
