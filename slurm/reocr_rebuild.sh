#!/bin/bash
# Login-node helper: stop any stuck reocr_apply worker and relaunch the 4 build
# workers (resumable — they skip already-built PDFs). Named distinctly so its own
# pkill pattern doesn't self-match.
R=/scratch/devon7y/reocr
pkill -u devon7y -f 'reocr_apply.py' 2>/dev/null
sleep 3
source /scratch/devon7y/westbury_rag/venv/bin/activate
cd "$R"
for c in 00 01 02 03; do
  nohup python reocr_apply.py --list "chunk_$c.txt" --pdf-dir pdfs_in --md-dir text_out \
    --out updated_pdfs --dpi 150 --timeout 90 > "apply_$c.log" 2>&1 &
done
echo "relaunched 4 build workers (resumable, with 90s per-paper timeout)"
