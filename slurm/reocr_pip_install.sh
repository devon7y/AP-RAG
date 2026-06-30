#!/bin/bash
# Runs INSIDE the python:3.12 Apptainer container (apptainer exec --cleanenv) to
# populate the re-OCR venv. Standard Debian Linux => manylinux wheels install
# cleanly (no source builds).
set -e
export PIP_CACHE_DIR=/scratch/devon7y/reocr/pip_cache
source /scratch/devon7y/reocr/cvenv/bin/activate
pip install --upgrade pip
pip install infinity_parser2
python -c "import infinity_parser2 as ip; print('infinity_parser2', getattr(ip,'__version__','ok'))"
python -c "import vllm; print('vllm', vllm.__version__)"
echo CONTAINER_VENV_DONE
