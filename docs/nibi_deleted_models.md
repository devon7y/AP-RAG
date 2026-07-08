# Nibi deleted models (2026-07-08)

Deleted from `/scratch/devon7y/huggingface/` on **Nibi** to get its scratch under the 1 TB soft quota
(it was at 12 TiB with the grace period expired, so all writes were blocked) so Nibi could join the AP-RAG ingest race.

**KEPT (needed by the run, NOT deleted):** `hub/models--Qwen--Qwen3.6-35B-A3B` and the embedder `westbury_rag/hf_cache/hub/models--Qwen--Qwen3-Embedding-8B`.

**To restore any of these:** `hf download <repo_id>` on a login node (has internet). Repo IDs and original sizes:

| Repo ID | Size |
|---|---|
| `ubergarm/Kimi-K2.6-GGUF
` | 460G |
| `ubergarm/Kimi-K2.5-GGUF
` | 460G |
| `OpenGVLab/InternVL3_5-241B-A28B
` | 449G |
| `unsloth/GLM-5.1-GGUF
` | 433G |
| `unsloth/GLM-5-GGUF
` | 425G |
| `MiniMaxAI/MiniMax-M3-MXFP8
` | 414G |
| `Qwen/Qwen3.5-397B-A17B-FP8
` | 379G |
| `unsloth/cogito-671b-v2.1-GGUF
` | 378G |
| `unsloth/DeepSeek-V3.1-Terminus-GGUF
` | 378G |
| `unsloth/DeepSeek-V3.1-GGUF
` | 378G |
| `unsloth/DeepSeek-R1-GGUF
` | 377G |
| `sszymczyk/DeepSeek-V3.2-nolight-GGUF
` | 377G |
| `sszymczyk/DeepSeek-V3.2-Exp-light-GGUF
` | 377G |
| `0xSero/Hy3-preview-FP8
` | 280G |
| `mradermacher/InternVL3_5-241B-A28B-i1-GGUF
` | 265G |
| `CohereLabs/command-a-plus-05-2026-bf16
` | 240G |
| `Qwen/Qwen3.5-122B-A10B
` | 234G |
| `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16
` | 231G |
| `mistralai/Mistral-Small-4-119B-2603
` | 226G |
| `CohereLabs/command-a-reasoning-08-2025
` | 207G |
| `zai-org/GLM-4.5-Air
` | 206G |
| `deepcogito/cogito-v2-preview-llama-109B-MoE
` | 203G |
| `unsloth/GLM-4.7-GGUF
` | 202G |
| `unsloth/GLM-4.5-GGUF
` | 202G |
| `zai-org/GLM-4.6V
` | 201G |
| `zai-org/GLM-4.5V
` | 201G |
| `unsloth/GLM-4.6-GGUF
` | 201G |
| `openai/gpt-oss-120b
` | 183G |
| `bartowski/MiMo-V2.5-GGUF
` | 176G |
| `AIDC-AI/Ovis2.6-80B-A3B
` | 151G |
| `tencent/Hunyuan-A13B-Instruct
` | 150G |
| `deepseek-ai/DeepSeek-V4-Flash
` | 149G |
| `FreedomIntelligence/openPangu-R-72B-2512
` | 144G |
| `LGAI-EXAONE/K-EXAONE-236B-A23B-GGUF
` | 134G |
| `deepcogito/cogito-v2-preview-llama-70B
` | 132G |
| `deepcogito/cogito-v1-preview-llama-70B
` | 132G |
| `NousResearch/Hermes-4-70B
` | 132G |
| `bartowski/command-a-plus-05-2026-GGUF
` | 126G |
| `zai-org/GLM-4.5-Air-FP8
` | 105G |
| `nvidia/Llama-3_3-Nemotron-Super-49B-v1
` | 93G |
| `OpenGVLab/InternVL3_5-38B
` | 72G |
| `NousResearch/Hermes-4.3-36B
` | 68G |
| `ByteDance-Seed/Seed-OSS-36B-Instruct
` | 68G |
| `LGAI-EXAONE/EXAONE-4.5-33B
` | 64G |
| `naver-hyperclovax/HyperCLOVAX-SEED-Think-32B
` | 63G |
| `baichuan-inc/Baichuan-M2-32B
` | 63G |
| `nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning-BF16
` | 62G |
| `Qwen/Qwen3-32B
` | 62G |
| `LGAI-EXAONE/EXAONE-4.0-32B
` | 60G |
| `zai-org/GLM-4.7-Flash
` | 59G |
| `nvidia/Nemotron-Cascade-2-30B-A3B
` | 59G |
| `Qwen/Qwen3-30B-A3B
` | 57G |
| `CohereLabs/North-Mini-Code-1.0
` | 57G |
| `naver-hyperclovax/HyperCLOVAX-SEED-Think-14B
` | 55G |
| `moondream/moondream3-preview
` | 45G |
| `OpenGVLab/InternVL3_5-GPT-OSS-20B-A4B-Preview
` | 40G |
| `openai/gpt-oss-20b
` | 39G |
| `inclusionAI/Ring-lite
` | 32G |
| `NousResearch/Hermes-4-14B
` | 28G |
| `openbmb/MiniCPM4.1-8B
` | 16G |
| `openbmb/MiniCPM5-1B
` | 2.1G |
| `zai-org/GLM-4.7
` | 23M |
| `zai-org/GLM-4.6
` | 23M |
| `zai-org/GLM-4.5
` | 23M |
| `Qwen/Qwen3-235B-A22B
` | 19M |
| `NousResearch/Hermes-4-405B
` | 17M |
| `unsloth/MiMo-V2-Flash-GGUF
` | 22K |
| `unsloth/GLM-4.5-Air-GGUF
` | 4.5K |
| `unsloth/Qwen3-235B-A22B-GGUF
` | 512 |

Total: 69 models, ~11.5 TB freed.
