# Starting the Westbury RAG Server on the PC

How to bring the Westbury RAG backend up on the always-on PC after a reboot. The
system is **not** configured to start on boot — start it manually with the steps
below whenever the PC has just been turned on.

- **PC SSH alias:** `pc`
- **PC Tailscale IP:** `100.98.84.84`
- **Server root on PC:** `C:\rag_server\`
- **Clients** (the `aprag` package — CLI `aprag` and/or MCP `aprag-mcp` — on other
  machines) reach this PC over Tailscale at port 8001 — see [APRAG_ACCESS.md](APRAG_ACCESS.md).

---

## TL;DR — one command from this repo

From the Mac, in the repo root:

```bash
bash restart_aprag_pc.sh
```

This starts all three services in the correct order, waits for each to become
healthy, and prints a Mac-side health check at the end. The Octen 8B embedding
model takes ~1–3 min to load, so the script can take a few minutes. When it
finishes you should see all three of `:8000`, `:8001`, `:6333` listening and a
final `{"status":"ok",...,"llm":"gpt-5-mini"}` line.

Then confirm retrieval actually works (see [Verify](#verify) below).

---

## What's running (three services)

| Service | Port | Scheduled task | Launches | Runs as |
|---|---|---|---|---|
| Octen embeddings | 8000 | `OctenEmbedServer` | `start_server.bat` → `uvicorn server:app` | devon7y (needs the GPU) |
| Qdrant vector DB | 6333 | `Qdrant` | `start_qdrant.bat` → `qdrant.exe` | SYSTEM |
| Query API | 8001 | `WestburyQueryServer` | `start_query_server.bat` → `uvicorn query_server:app` | devon7y |

The **query server (8001)** is the entry point: it loads the LightRAG store from
`C:\rag_server\rag_storage_westbury_qwen3_32b`, embeds queries via Octen (8000),
retrieves from Qdrant (6333), and synthesizes answers with **gpt-5-mini** (OpenAI
API).

**Start order matters:** Octen and Qdrant must be up *before* the query server,
because the query server connects to both when it loads. `restart_aprag_pc.sh`
enforces this ordering.

---

## ⚠️ Critical rule: always start these via Task Scheduler, never directly over SSH

Windows OpenSSH **kills the entire process tree when the SSH session ends**. So if
you launch a service directly — e.g. `ssh pc "qdrant.exe"` or PowerShell
`Start-Process` inside an SSH session — it dies the moment the command returns.

Every service is therefore started through **`schtasks /Run`**. Task Scheduler runs
the process detached from the SSH session, so it survives the disconnect. This is
exactly why the `Qdrant` task exists (Qdrant used to be launched with
`Start-Process` and would silently die seconds after startup, leaving the query
server returning *"No relevant information found"* / `[no-context]`).

---

## Manual start (if you don't use the script)

Run these from the Mac, in order. Each `schtasks /Run` returns immediately; give
each service a moment, then check its health before starting the next.

```bash
# 1. Clear any hung query-server instance from a previous run
ssh pc "schtasks /End /TN WestburyQueryServer"

# 2. Octen embeddings (slowest — model load)
ssh pc "schtasks /Run /TN OctenEmbedServer"
curl -s http://100.98.84.84:8000/health        # wait for {"status":"ok",...}

# 3. Qdrant
ssh pc "schtasks /Run /TN Qdrant"
curl -s http://100.98.84.84:6333/healthz        # wait for "healthz check passed"

# 4. Query server (connects to Octen + Qdrant at startup)
ssh pc "schtasks /Run /TN WestburyQueryServer"
curl -s http://100.98.84.84:8001/health         # wait for {"status":"ok",...}
```

---

## Verify

Health endpoints confirm the processes are up, but **always run a real query** —
health can pass while retrieval is broken (e.g. if Qdrant died after the query
server loaded).

```bash
# Health
curl -s http://100.98.84.84:8000/health   # Octen:  {"status":"ok","model":"...","vram_gb":~8.2}
curl -s http://100.98.84.84:6333/healthz  # Qdrant: healthz check passed
curl -s http://100.98.84.84:8001/health   # Query:  {"status":"ok",...,"llm":"gpt-5-mini"}

# End-to-end retrieval (this is the real test)
curl -s -X POST http://100.98.84.84:8001/query \
  -H "Content-Type: application/json" \
  -d '{"question":"What has Westbury research found about humor and incongruity?","mode":"hybrid"}'
```

A healthy system returns a multi-paragraph answer with `[n]` citations. If you get
`No relevant information found` or `[no-context]`, retrieval is broken — see
troubleshooting. Modes: `hybrid` (default), `local`, `global`, `naive`.

---

## Stopping the services

```bash
ssh pc "schtasks /End /TN WestburyQueryServer"
ssh pc "schtasks /End /TN OctenEmbedServer"
ssh pc "schtasks /End /TN Qdrant"
```

---

## Auto-start on boot is intentionally OFF

Per preference, the services do **not** launch on boot:

- `OctenEmbedServer` and `WestburyQueryServer` — their "At system start up"
  triggers are **disabled** (the tasks stay enabled so `schtasks /Run` still works).
- `Qdrant` — created with only a past-dated one-time trigger (2020-01-01), which
  never fires.

To re-enable auto-start later (from the Mac), re-enable the boot triggers and add
a boot trigger to Qdrant:

```bash
ssh pc 'powershell -NoProfile -Command "foreach($n in \"OctenEmbedServer\",\"WestburyQueryServer\"){$t=Get-ScheduledTask $n; $t.Triggers[0].Enabled=$true; Set-ScheduledTask $n -Trigger $t.Triggers}"'
ssh pc 'schtasks /Change /TN Qdrant /ENABLE'   # then add an ONSTART trigger if desired
```

---

## Troubleshooting

**`No relevant information found` / `[no-context]` despite health checks passing.**
Almost always Qdrant is down or was restarted after the query server loaded.
1. Check Qdrant: `curl -s http://100.98.84.84:6333/collections` — should list
   `lightrag_vdb_entities`, `lightrag_vdb_relationships`, `lightrag_vdb_chunks`.
2. If Qdrant is down, start it: `ssh pc "schtasks /Run /TN Qdrant"`.
3. Re-run a query. The query server reconnects to Qdrant automatically (HTTP
   client, no restart needed). If it still fails, restart the query server:
   `ssh pc "schtasks /End /TN WestburyQueryServer"` then
   `ssh pc "schtasks /Run /TN WestburyQueryServer"`.

**A service won't stay up.** Confirm you started it via `schtasks /Run`, not by
launching the process directly over SSH (see the critical rule above). Check the
task result: `ssh pc "schtasks /Query /TN <Task> /FO LIST /V"`.

**Check what's listening / running on the PC:**
```bash
ssh pc 'powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 8000,8001,6333 -State Listen | Select LocalPort,OwningProcess | Format-Table -AutoSize"'
```

**Logs on the PC** (under `C:\rag_server\`): `server.log` (Octen),
`qdrant_stdout.log` / `qdrant_stderr.log` (Qdrant), `query_server.log` (query API).

**SSH note:** prefer passing PowerShell as a single `-Command` argument or via
`-EncodedCommand`; piping a multi-line script to `powershell -Command -` over this
SSH connection has proven unreliable.
