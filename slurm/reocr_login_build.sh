#!/bin/bash
# Build the re-OCR venv + download the model on the Rorqual LOGIN node (compute
# nodes have no outbound internet). Run detached: nohup bash reocr_login_build.sh &
set -e
module load python/3.12 gcc/12.3 cuda/12.6 opencv
cd /scratch/devon7y/reocr
export HF_HOME=/scratch/devon7y/huggingface

echo "[$(date)] creating venv ..."
rm -rf reocr_venv
python -m venv reocr_venv
source reocr_venv/bin/activate

# Bypass the Compute Canada wheelhouse (its pinned +computecanada builds shadow
# PyPI and conflict with infinity_parser2's newer deps, e.g. scipy>=1.17.1).
export PIP_CONFIG_FILE=/dev/null
export PIP_INDEX_URL=https://pypi.org/simple
unset PIP_FIND_LINKS PIP_NO_INDEX
pip install --upgrade pip

echo "[$(date)] installing infinity_parser2 (+ vllm/transformers deps) from PyPI ..."
pip install infinity_parser2 \
  || pip install "git+https://github.com/infly-ai/INF-MLLM.git#subdirectory=Infinity-Parser2"
pip install pymupdf "huggingface_hub[cli]"

echo "[$(date)] versions:"
python -c "import infinity_parser2 as ip; print('infinity_parser2', getattr(ip,'__version__','ok'))" || echo "WARN ip import"
python -c "import vllm; print('vllm', vllm.__version__)" || echo "WARN vllm import"

echo "[$(date)] downloading infly/Infinity-Parser2-Pro into $HF_HOME ..."
hf download infly/Infinity-Parser2-Pro

echo "[$(date)] LOGIN_BUILD_DONE"
