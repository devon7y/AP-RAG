#!/bin/bash
# Build the re-OCR environment inside an Apptainer container, because Compute
# Canada's custom Python forces failing source-builds (pymupdf/mupdf) for
# infinity_parser2's deps. A stock python:3.12 image is standard Linux, so all
# manylinux wheels (pymupdf, torch, vllm, scipy) install cleanly. Run on the
# LOGIN node (internet); the venv persists on /scratch and is reused at run time.
set -e
module load apptainer 2>/dev/null || true
R=/scratch/devon7y/reocr
cd "$R"
export APPTAINER_CACHEDIR=$R/apptainer_cache
mkdir -p "$APPTAINER_CACHEDIR"

echo "[$(date)] pulling python:3.12 image ..."
apptainer pull --force py312.sif docker://python:3.12

echo "[$(date)] creating venv + installing infinity_parser2 inside the container ..."
# --cleanenv: don't inherit the host's SSL_CERT_FILE (points at a RHEL path absent
# in the Debian image), so pip/certifi use the container's own CA bundle.
apptainer exec --cleanenv --bind /scratch py312.sif bash -c "
  set -e
  export PIP_CACHE_DIR=$R/pip_cache
  python -m venv $R/cvenv
  source $R/cvenv/bin/activate
  pip install --upgrade pip
  pip install infinity_parser2
  python -c 'import infinity_parser2 as ip; print(\"infinity_parser2\", getattr(ip,\"__version__\",\"ok\"))'
  python -c 'import vllm; print(\"vllm\", vllm.__version__)'
"
echo "[$(date)] CONTAINER_BUILD_DONE"
