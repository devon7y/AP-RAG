# Octen Embedding Server — PC Setup

PC is an always-on Windows machine used to serve `Octen/Octen-Embedding-8B-INT8` embeddings
for local RAG querying, accessible remotely via Tailscale.

---

## Hardware

| Component | Details |
| --- | --- |
| GPU | NVIDIA GeForce RTX 4070 Ti |
| VRAM | 12.3 GB |
| RAM | 32 GB |
| Driver | 581.42 |
| CUDA | 13.0 (driver) |
| OS | Windows |

---

## Installation

### Prerequisites

Python 3.11.9 at `C:\Users\devon\AppData\Local\Programs\Python\Python311\`.

### Virtual Environment

```text
C:\rag_server\venv\
```

Created with:

```powershell
python -m venv C:\rag_server\venv
```

### Dependencies

PyTorch must be installed **first** with the CUDA 12.4 index URL, then the rest.
If you install `sentence-transformers` first, pip will pull the CPU-only torch and
you'll need to force-reinstall.

```powershell
# Step 1 — PyTorch CUDA 12.4 (driver is CUDA 13.0 but 12.4 build is latest stable)
C:\rag_server\venv\Scripts\pip install torch --index-url https://download.pytorch.org/whl/cu124

# Step 2 — Everything else
C:\rag_server\venv\Scripts\pip install sentence-transformers bitsandbytes accelerate

# Step 3 — If pip downgraded torch to CPU version, force reinstall
C:\rag_server\venv\Scripts\pip install torch --index-url https://download.pytorch.org/whl/cu124 --force-reinstall --no-deps
```

Verify CUDA is active:

```powershell
C:\rag_server\venv\Scripts\python -c "import torch; print(torch.__version__); print(torch.cuda.is_available())"
# Expected: 2.6.0+cu124 / True
```

---

## Windows Paging File (Required)

safetensors memory-maps the model weights (~7.8 GB across two shards) into virtual
address space. With the default small initial paging file size, Windows cannot back the
memory map and throws:

```text
OSError: The paging file is too small for this operation to complete. (os error 1455)
```

**Fix:** Set the paging file to a fixed size so no on-the-fly growth is needed.

1. `Win + R` → `sysdm.cpl` → Enter
2. **Advanced** → **Performance** → **Settings**
3. **Advanced** → **Virtual Memory** → **Change**
4. Uncheck **Automatically manage paging file size for all drives**
5. Select C: → **Custom size**:
   - Initial size: **16384 MB**
   - Maximum size: **16384 MB**
6. Click **Set** → **OK** → **Reboot**

> **Why 16384?** The model is ~7.8 GB. With 32 GB RAM and 16 GB pagefile = 48 GB total
> virtual memory — well above what's needed. The key is making initial = maximum so
> Windows never needs to grow the file at runtime.

---

## Model

- **ID:** `Octen/Octen-Embedding-8B-INT8`
- **Embedding dim:** 4096
- **VRAM at load:** ~8.19 GB (leaves ~4.5 GB headroom on RTX 4070 Ti)
- **Load time:** ~4 seconds (weights already cached in HuggingFace cache)
- **Cache location:** `C:\Users\devon\.cache\huggingface\hub\models--Octen--Octen-Embedding-8B-INT8\`
- **Shard sizes:** ~3.1 GB + ~4.7 GB (two safetensors shards)

Input texts must be prefixed with `"- "` per Octen/Qwen3 model instructions.

---

## Test Script

`C:\rag_server\test_octen.py` — loads the model and encodes a test sentence:

```python
import os
os.environ["SAFETENSORS_FAST_GPU"] = "1"
import torch
from sentence_transformers import SentenceTransformer

print("Loading Octen-Embedding-8B-INT8...")
m = SentenceTransformer("Octen/Octen-Embedding-8B-INT8", device="cuda")
print("VRAM used:", round(torch.cuda.memory_allocated()/1e9, 2), "GB")
v = m.encode(["- test sentence"], normalize_embeddings=True)
print("Embedding dim:", len(v[0]))
print("SUCCESS")
```

Expected output:

```text
VRAM used: 8.19 GB
Embedding dim: 4096
SUCCESS
```

---

## Embedding Server

`C:\rag_server\server.py` — FastAPI app, loads Octen once at startup, exposes an
OpenAI-compatible `/v1/embeddings` endpoint.

### Install additional dependencies

```powershell
C:\rag_server\venv\Scripts\pip install fastapi "uvicorn[standard]"
```

### Run manually (for testing)

```powershell
C:\rag_server\venv\Scripts\python -m uvicorn server:app --host 0.0.0.0 --port 8000
```

Expected startup output:

```text
Loading Octen/Octen-Embedding-8B-INT8 on cuda…
Model ready. VRAM: 8.19 GB
INFO:     Uvicorn running on http://0.0.0.0:8000
```

### Endpoints

| Method | Path | Description |
| --- | --- | --- |
| GET | `/health` | Liveness check — returns model name and VRAM usage |
| POST | `/v1/embeddings` | OpenAI-compatible embeddings |

### Test with curl

```powershell
# Health check
curl http://localhost:8000/health

# Embedding
curl -X POST http://localhost:8000/v1/embeddings `
  -H "Content-Type: application/json" `
  -d '{"input": ["test sentence"], "model": "Octen"}'
```

The server prepends `"- "` to every input text automatically (per Octen/Qwen3
model instructions) — callers do **not** need to prefix themselves.

### Use with OpenAI Python client

```python
from openai import OpenAI

client = OpenAI(base_url="http://<tailscale-ip>:8000/v1", api_key="ignored")
resp = client.embeddings.create(model="Octen", input=["my text"])
print(len(resp.data[0].embedding))  # 4096
```

---

## Remote Access via Tailscale

Tailscale creates a private mesh VPN between your devices. The PC is reachable at a
stable `100.x.x.x` IP from any network — no port forwarding, no dynamic DNS.

### Install Tailscale

1. **PC:** Download from [tailscale.com/download](https://tailscale.com/download) → install → sign in
2. **Mac:** `brew install --cask tailscale` → sign in with the same account

Both devices will appear in your Tailscale admin console with stable `100.x.x.x` IPs.

### Find the PC's Tailscale IP

On the PC (after Tailscale is running):

```powershell
tailscale ip -4
# e.g. 100.64.0.2
```

Or check [login.tailscale.com/admin/machines](https://login.tailscale.com/admin/machines).

### Connect from Mac

```bash
# Health check
curl http://100.64.0.2:8000/health

# Embedding
curl -X POST http://100.64.0.2:8000/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{"input": ["test sentence"], "model": "Octen"}'
```

> Windows Firewall note: Windows may block inbound connections on port 8000.
> If the request times out, add an inbound rule:
> `Win + R` → `wf.msc` → **Inbound Rules** → **New Rule** → Port → TCP 8000 → Allow

---

## Windows Service (Auto-start)

To have the server start automatically when the PC boots, register it as a Windows
service using NSSM (Non-Sucking Service Manager).

### Install NSSM

```powershell
winget install nssm
```

### Register the service

```powershell
nssm install OctenEmbedServer `
  C:\rag_server\venv\Scripts\python.exe `
  "-m uvicorn server:app --host 0.0.0.0 --port 8000"

nssm set OctenEmbedServer AppDirectory C:\rag_server
nssm set OctenEmbedServer AppEnvironmentExtra SAFETENSORS_FAST_GPU=1
nssm set OctenEmbedServer Start SERVICE_AUTO_START
nssm set OctenEmbedServer AppStdout C:\rag_server\logs\server.log
nssm set OctenEmbedServer AppStderr C:\rag_server\logs\server.log
nssm set OctenEmbedServer AppRotateFiles 1

# Create log directory
mkdir C:\rag_server\logs

# Start it
nssm start OctenEmbedServer
```

### Service management

```powershell
nssm status OctenEmbedServer   # Running / Stopped
nssm restart OctenEmbedServer
nssm stop OctenEmbedServer
nssm remove OctenEmbedServer confirm  # uninstall
```

Logs at `C:\rag_server\logs\server.log`.
