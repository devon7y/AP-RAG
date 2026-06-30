#!/bin/bash
# Login-node helper: stop the slow sequential-pip venv install and relaunch it with
# uv (parallel downloads). Named distinctly so its own pkill patterns don't self-match.
R=/scratch/devon7y/reocr
module load apptainer 2>/dev/null || true
pkill -u devon7y -f 'reocr_pip_install.sh' 2>/dev/null
pkill -u devon7y -f 'pip install infinity_parser2' 2>/dev/null
sleep 2
nohup apptainer exec --cleanenv --bind /scratch "$R/py312.sif" bash "$R/reocr_uv_install.sh" \
  > "$R/container_uv.log" 2>&1 &
echo UV_RELAUNCH_PID $!
