# vLLM TP=2 Intermittent Hang/Crash — Debugging Handoff

**Status:** FIX PACKAGE DEPLOYED (2026-07-02, see §0) — root-cause candidate addressed
(mid-serve JIT/autotune on shared network-FS caches), residual-hang insurance in place
(watchdog + auto-diagnostics + in-job restart). Needs a **≥8 h TP=2 soak** to confirm;
if a hang still occurs, the watchdog now captures the worker stack that names the kernel.
**Written:** 2026-07-02, from live evidence on the Rorqual run (`15040788/89/90`).
**Goal for the reader:** find and fix the root cause of vLLM engine hangs so a TP=2 vLLM
serving `Qwen/Qwen3.6-35B-A3B` survives a multi-day ingest without dying every few hours.

---

## 0. ✅ What was implemented (2026-07-02) and why

### 0.1 Upstream research (what's known)

- **The exact signature is an OPEN upstream bug with no fix:**
  [vllm#36921](https://github.com/vllm-project/vllm/issues/36921) — Qwen3.5-122B-A10B
  (same GDN hybrid family), V1 engine, burst load → `No available shared memory broadcast
  block` → `RPC call to sample_tokens timed out`, random 5 min–4.5 h to failure. Their
  attempts (lower `--max-num-batched-tokens`, Ray backend, concurrency ramps) all failed.
  ⇒ **No version bump fixes this today**; treat it as ours to mitigate + evidence.
- **Mid-inference Triton JIT is a documented TP=2 hang mechanism:**
  [vllm#45198](https://github.com/vllm-project/vllm/issues/45198) — both TP ranks
  simultaneously JIT-compile the same Triton kernel *during inference* and deadlock, with
  the same shm warning. Our worker logs show GDN decode kernels
  (`fused_recurrent_gated_delta_rule…`, `causal_conv1d…`) JIT-compiling **during serving**
  (§4), and eager mode does NOT prevent Triton JIT — matching "eager tripled MTTF but
  didn't cure it" (§6).
- **Deployment-specific aggravator found in our scripts:** `TRITON_CACHE_DIR` and
  `FLASHINFER_CACHE_DIR` pointed at **one shared directory on Lustre/VAST**
  (`$WORKDIR/cache/...`) written concurrently by **2 TP ranks × up to 3 vLLM jobs**.
  Triton's cache relies on file locks + atomic renames that are slow/unreliable on
  network filesystems — a multi-minute stall or deadlock waiting on a cache lock during a
  mid-serve compile is exactly the observed failure shape.
- **The fatal timer is configurable:** the death comes from the multiproc executor's
  execute-model RPC timeout, env `VLLM_EXECUTE_MODEL_TIMEOUT_SECONDS`, **default 300 s**
  ([vllm PR#19544](https://github.com/vllm-project/vllm/pull/19544)) — matching the
  observed ~5-min warning window before death.
- FlashInfer **autotune + TP + eager** is a known-fragile combination
  ([vllm#27751](https://github.com/vllm-project/vllm/issues/27751) — a startup-crash
  variant, fixed upstream, but it shows this config corner is under-tested). Autotune =
  more mid-serve tuning/JIT. Skip knob: `VLLM_SKIP_FLASHINFER_AUTOTUNE=1`.

### 0.2 The deployed fix package (all in `slurm/job_westbury_vllm_{nibi,fir,ror,tril}.slurm`)

| # | Change | Default / knob | Addresses |
| --- | --- | --- | --- |
| 1 | **Node-local JIT caches, seeded from the shared one** — `TRITON_CACHE_DIR`/`FLASHINFER_CACHE_DIR` → `$SLURM_TMPDIR/...`, warm-copied from Lustre at startup; all JIT writes stay on local NVMe | `VLLM_LOCAL_JIT_CACHE=1` | the network-FS lock stall/deadlock aggravator (§0.1) |
| 2 | **Skip FlashInfer autotune** (heuristics path — marginally slower, stable) | `VLLM_SKIP_FLASHINFER_AUTOTUNE=1` | mid-serve tuning/JIT churn; fragile autotune+TP+eager corner |
| 3 | **Raise the fatal RPC timeout 300 s → 1200 s** | `VLLM_EXECUTE_MODEL_TIMEOUT_SECONDS=1200` | finite stalls (slow compile) become latency blips, not engine death (§7.5) |
| 4 | **Pre-warm before registering the endpoint** — a small battery of completions (concurrency 1/4/8) forces the lazy decode-kernel JIT while nothing depends on the server | `VLLM_PREWARM=1` | shrinks what's left to compile mid-serve |
| 5 | **Hang watchdog + auto-diagnostics** — engine output goes to its own log (`logs/vllm_engine_<jobid>_rN.log`); on the FIRST shm-broadcast warning, `py-spy dump` of EVERY vLLM process (EngineCore + both TP workers) + `nvidia-smi` + log tail → `logs/vllm_hang_diag_<jobid>_rN.txt` | always on | §7.1 — the worker stack that **names the hung kernel** is captured in the pre-death window automatically |
| 6 | **In-job auto-restart** — on engine death: deregister endpoint file, restart vLLM in-place on a fresh port, pre-warm, re-register. NOT a SLURM resubmission (job-chain rule intact); the ingest's failover + `ENDPOINT_REFRESH_S` re-discovery adopt the reincarnation within ~5 min of it passing health | `VLLM_MAX_RESTARTS=3` | a crash now costs ~10 min of one endpoint, not the rest of the job's walltime |
| 7 | `py-spy` installed by the setup jobs (`job_setup_env*`; Trillium: wheelhouse, best-effort) | — | enables #5 |

Also relevant, already shipped earlier the same day (commit `09cd595`): **`max_tokens` is
now capped** (`LLM_MAX_TOKENS=4096`, blurbs 300) — §7.4's exposure-window reduction — and
the ingest **adopts endpoints registered mid-run** (`ENDPOINT_REFRESH_S`), which is what
makes #6's reincarnations actually get used.

### 0.3 Revised runbook for the next occurrence

1. If the engine **survives** a stall (timeout raise doing its job): a diag file still
   appears (`vllm_hang_diag_*_rN.txt`) — read the worker stacks; if a
   `gated_delta_rule`/`causal_conv1d`/Triton-compile frame shows up, that's the culprit
   confirmed while the run keeps going.
2. If the engine **dies**: the supervisor restarts it (watch for
   `Restarting vLLM in-place` in the job .out); read the same diag file.
3. With a named kernel/frame: report to vllm-project with the stack (reference
   [#36921](https://github.com/vllm-project/vllm/issues/36921)), and/or test a newer
   nightly for that specific kernel fix — re-pin via `VLLM_PIN` + ≥8 h soak (§10).
4. Diagnostic escalation knobs (submit-time env, no script edits):
   `NCCL_DEBUG=INFO`, `CUDA_LAUNCH_BLOCKING=1` (slow, diagnostic runs only),
   `VLLM_ATTENTION_BACKEND=...`, `VLLM_LOCAL_JIT_CACHE=0` (revert cache change for A/B),
   `VLLM_SKIP_FLASHINFER_AUTOTUNE=0` (revert autotune skip for A/B).
5. **Soak validation:** ≥8 h TP=2 under real ingest load. Success = zero
   `vllm_hang_diag_*` files, or diag files whose stalls all recovered (engine alive,
   no restarts).

---

## 1. One-paragraph summary

A vLLM engine serving **Qwen3.6-35B-A3B (MoE, BF16) on TP=2 (2× H100)** hangs
intermittently after hours of steady serving. The driver process (`EngineCore`) prints
`No available shared memory broadcast block found in 60 seconds` for several minutes, then
dies with **`TimeoutError: RPC call to sample_tokens timed out`** — i.e. a **tensor-parallel
worker rank stopped responding** during a decode/sample step and the driver's inter-process
RPC timed out. It is **not** OOM, **not** a client/request error, and **not** compilation
(it still happens with `--enforce-eager`). The prime suspect is vLLM's TP handling of this
model's **gated-delta-rule / linear-attention (GDN) hybrid** decode kernels.

---

## 2. The exact failure (verbatim, from `15040788`, 2026-07-02 13:49 EDT)

Driver (`EngineCore`) traceback:

```text
run_busy_loop → _process_engine_step → step_with_batch_queue → future.result()
  → multiproc_executor.get_response
  → shm_broadcast.dequeue → acquire_read → timeout_ms → raise TimeoutError

The above exception was the direct cause of:
  multiproc_executor.get_response:
    raise TimeoutError(f"RPC call to {method} timed out.") from e
TimeoutError: RPC call to sample_tokens timed out.
```

Preceded (for ~5–10 min) by repeated:

```text
[shm_broadcast.py:705] No available shared memory broadcast block found in 60 seconds.
This typically happens when some processes are hanging or doing some time-consuming work
(e.g. compilation, weight/kv cache quantization).
```

Interpretation: rank 0 (driver) broadcasts each step's work to the TP worker(s) over a
shared-memory ring buffer and waits for the response. A worker **stopped consuming/responding**
(a CUDA op on that rank hung), the ring filled ("no available block"), and after the read
timeout the driver raised `TimeoutError` on the `sample_tokens` RPC → fatal → engine teardown.
The SLURM wrapper's health loop then sees the dead PID and exits `0` (so `sacct` misleadingly
says `COMPLETED` — **it is a crash**).

---

## 3. Engine state at the moment of the hang (from the crash dump)

- **Config (confirmed):** `tensor_parallel_size=2`, `dtype=bfloat16`, `max_seq_len=40000`,
  `enforce_eager=True`, `disable_custom_all_reduce=True`, `cudagraph_mode=NONE`,
  `compilation_config.mode=NONE`, `enable_prefix_caching=True`, `enable_chunked_prefill=True`,
  `kv_cache_dtype=auto`, `enable_flashinfer_autotune=True`, `moe_backend='auto'`,
  `dcp_comm_backend='ag_rs'`. vLLM `0.23.1rc1.dev245+g9037498c2`.
- **Scheduler state:** `num_running_reqs=11`, all in **decode** (`num_scheduled_tokens=1`
  each), `num_output_tokens` between **1897 and 2481** (long generations),
  `kv_cache_usage=0.024` (**low** — not memory pressure), `num_waiting=0`.

So: it hung during a normal multi-request **decode** step, not at prefill, not under memory
pressure, not during compilation.

---

## 4. 🔑 The strongest lead: this is a GDN / linear-attention hybrid model

At startup the workers JIT-compiled these Triton kernels (from `15040788` worker log, ~05:25):

```text
_triton_mrope_forward
_causal_conv1d_update_kernel
fused_recurrent_gated_delta_rule_packed_decode_kernel
batch_memcpy_kernel
fused_sigmoid_gating_delta_rule_update_kernel
```

and the compile config's `splitting_ops` listed `mamba_mixer2, mamba_mixer, short_conv,
linear_attention, qwen_gdn_attention_core, gdn_attention_core_xpu, kda_attention`, etc.

**Qwen3.6-35B-A3B is a hybrid architecture** using **gated delta networks (GDN) /
linear-attention + causal-conv1d** layers (Mamba-style recurrent state) interleaved with MoE.
These are **stateful decode kernels** (they carry recurrent state across steps) and are
relatively new in vLLM. This is the most likely locus of a rare TP-side hang:

- a recurrent-state update kernel that desyncs or deadlocks across the two TP ranks, or
- a numerical edge (NaN/inf in the delta-rule state) that stalls one rank's kernel, or
- an immature TP code path for these layers.

The reader should **focus here first.** Search vLLM issues/PRs for
`Qwen3.6` / `gated_delta_rule` / `linear_attention` / `GDN` + `TP` + `hang`/`timeout`.

---

## 5. What is already ruled OUT

| Hypothesis | Ruled out because |
| --- | --- |
| OOM | `kv_cache_usage=0.024`; no `out of memory`; embedder OOM is a *separate* (fixed) issue. |
| torch.compile / CUDA-graph recompile stall | Crash persists with `enforce_eager=True`, `cudagraph_mode=NONE`. |
| Custom all-reduce bug | Crash persists with `disable_custom_all_reduce=True`. |
| Bad node / hardware | Crashed on multiple different nodes (rg31503, rg32002, rg31602, rg32…) across runs. |
| Client/request error | It's an internal engine RPC timeout, not an HTTP error to the client. |

---

## 6. What HAS been tried, and its effect

`--enforce-eager --disable-custom-all-reduce` were added (commit `db58843`). Effect on
**time-to-crash**:

| vLLM job | Flags | Lifetime before hang |
| --- | --- | --- |
| rg31503 (earlier) | none (CUDA graphs on) | **~2h51m** |
| rg32002 (earlier) | none | **~2h50m** |
| `15040790` (this run) | enforce-eager + no-custom-ar | **7h39m** |
| `15040788` (this run) | enforce-eager + no-custom-ar | **9h07m** |
| `15040789` (this run) | enforce-eager + no-custom-ar | **survived 10h42m+** (no crash) |

**So the flags ~tripled the mean time-to-failure (≈2h50m → ~8h) but did not eliminate it,**
and it's clearly probabilistic (one instance survived 10h+). CUDA graphs/compilation were
therefore a *contributing* trigger for the early crashes, but there is a **residual hang**
in the eager decode path (the GDN/sampling suspect in §4).

---

## 7. Debugging directions, ranked

1. **Capture a worker stack trace at hang time (highest value).** The crash dump only shows
   the *driver* waiting; it does not show *where the worker is stuck*. When the
   `No available shared memory broadcast block` warnings begin (worker already hung, ~5 min
   before the fatal error), attach **`py-spy dump --pid <Worker_TP*>`** (and/or `gdb -p` with
   `cuda-gdb`) to the worker process to get the exact Python/CUDA frame. Or launch vLLM with
   `faulthandler`/`VLLM_TRACE_FUNCTION` and send `SIGQUIT`. **This single stack trace will
   likely name the offending kernel** (expected: a `gated_delta_rule` / `causal_conv1d` /
   `linear_attention` op). Wire a watchdog: on the shm warning, auto-`py-spy` both workers.
2. **Try a different/newer vLLM build** with fixes for the Qwen3.6/GDN TP path. The current
   pin (`dev245+g9037498c2`) exists only because *other* nightlies regressed TP=2 — see
   `docs`/memory. Any change must be re-validated for TP=2 correctness *and* soaked ≥8h.
3. **Force known-stable backends** instead of `auto`: set `VLLM_ATTENTION_BACKEND` and the MoE
   backend explicitly; try `enable_flashinfer_autotune=False`. flashinfer autotune picking a
   path late in the run is a plausible trigger (note the "JIT compilation during inference"
   warnings — kernels are still compiling mid-serve).
4. **Cap `max_tokens` (~2–4k).** The hang happened with 11 concurrent decodes at **2000–2500
   output tokens each** (generations run uncapped toward `max_model_len`). Long decodes =
   many more GDN state-update steps = more exposure to the hang. Capping shrinks the exposure
   window and is independently desirable. (Tracked as "P5" in `docs/INGEST_EFFICIENCY_OPEN_PROBLEMS.md`.)
5. **Raise the RPC/shm read timeout** so a very-long-but-finite stall doesn't become fatal
   (search vLLM for the multiproc executor / shm-broadcast timeout env). Only a band-aid if
   it's a true deadlock, but cheap to test and may convert crashes into latency blips.
6. **NCCL/comms instrumentation:** `NCCL_DEBUG=INFO`, `TORCH_NCCL_TRACE_BUFFER_SIZE`,
   `CUDA_LAUNCH_BLOCKING=1` (diagnostic runs only — slow) to see if a collective/kernel is the
   stuck point. `dcp_comm_backend=ag_rs` is in play.
7. **Diagnostic only — TP=1 + FP8** (35B in FP8 ≈ 35GB fits one 80GB H100). If TP=1 never
   hangs, that confirms the bug is in the TP path (production still wants TP=2 for BF16, but
   this isolates the cause fast).

---

## 8. Environment / where to look

- **Model:** `Qwen/Qwen3.6-35B-A3B` (MoE + GDN/linear-attention hybrid), BF16.
- **Serving:** `vllm serve … --tensor-parallel-size 2 --enforce-eager
  --disable-custom-all-reduce --enable-prefix-caching --max-model-len 40000
  --gpu-memory-utilization 0.90` (see `slurm/job_westbury_vllm_{ror,fir,nibi,tril}.slurm`).
- **vLLM:** `0.23.1rc1.dev245+g9037498c2` (pinned; installed by `slurm/job_setup_env_*.slurm`).
  Backends: flashinfer (autotune on), Triton kernels JIT'd at runtime.
- **Hardware:** Alliance Canada H100 SXM5 80GB, 2 GPUs per vLLM, on Rorqual/Fir/Nibi.
- **Logs:** `$WORKDIR/logs/westbury_vllm_<jobid>.out` and `.err`
  (`$WORKDIR=/scratch/devon7y/westbury_rag` on Ror/Nibi,
  `/home/devon7y/scratch/devon7y/westbury_rag` on Fir). The `.out` holds the EngineCore
  traceback + the pre-crash `shm_broadcast` warnings; grep `EngineCore encountered a fatal
  error` and `sample_tokens timed out`.
- **Reproduce:** submit a vLLM job (the slurm scripts above) and drive it with sustained
  concurrent chat-completion load for many hours (the ingest does ~40 concurrent long
  generations). Expected: hang within ~2–10h. A synthetic loop of concurrent long-output
  requests should also trigger it.

---

## 9. Current mitigation (do not remove; it's what keeps the run alive)

The ingest **fails over** around a dead endpoint: `pipeline/ingest.py::_is_conn_error` +
`build_round_robin_llm` evict a hung/dead vLLM and route to survivors, so a crash costs **0
documents** — it only reduces throughput as the pool shrinks (3 vLLMs → 1 over ~10h halves
the rate). The operational answer today is "run ≥3 vLLMs + failover + resubmit." **Fixing the
hang would remove the need for that and roughly 2–3× effective throughput on a long run.**

---

## 10. Hard constraints for any fix

- **Do not edit `LightRAG/`** (kept patch-free for upgradability). vLLM flags/version and
  ingest-side changes only.
- **TP=2 is required** for this model in BF16 (~70GB won't leave KV room on one 80GB H100).
  A fix must keep TP=2 (FP8/TP=1 is a *diagnostic*, not the target config).
- **No SLURM job chains** (project rule).
- Any vLLM version/flag change must pass a **≥8h TP=2 soak** under realistic concurrent load
  before it's trusted (the crash MTTF is hours, so short tests prove nothing).
