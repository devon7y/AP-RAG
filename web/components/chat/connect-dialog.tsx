"use client";

import { CheckIcon, CopyIcon, PlugZapIcon } from "lucide-react";
import { useState } from "react";
import { useCopyToClipboard } from "usehooks-ts";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";

// Public endpoint of the AP-RAG query server (Cloudflare Tunnel → PC).
const SERVER_URL = "https://rag-api.devon7y.com";
const REPO = "git+https://github.com/devon7y/AP-RAG.git";

function Code({ children }: { children: string }) {
  const [, copy] = useCopyToClipboard();
  const [copied, setCopied] = useState(false);
  return (
    <div className="group relative">
      <pre className="overflow-x-auto rounded-lg border border-border/60 bg-muted/50 px-3 py-2 pr-9 text-[12px] leading-relaxed">
        <code>{children}</code>
      </pre>
      <button
        aria-label="Copy"
        className="absolute top-1.5 right-1.5 rounded-md p-1.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100"
        onClick={() => {
          copy(children);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
        type="button"
      >
        {copied ? (
          <CheckIcon className="size-3.5" />
        ) : (
          <CopyIcon className="size-3.5" />
        )}
      </button>
    </div>
  );
}

export function ConnectDialog() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          className="h-8 gap-1.5 rounded-lg px-2.5 text-xs"
          size="sm"
          variant="outline"
        >
          <PlugZapIcon className="size-3.5" />
          <span className="hidden sm:inline">Connect to your own agentic AI</span>
          <span className="sm:hidden">Connect AI</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] gap-0 overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Connect your own agentic AI</DialogTitle>
          <DialogDescription>
            AP-RAG is a thin client over the query server, so any MCP-capable agent
            (Claude Code, Codex, Gemini CLI, Cursor…) — or the plain CLI — can query the
            same corpus you see here.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-4 space-y-5 text-sm">
          {/* Install */}
          <section className="space-y-2">
            <h3 className="font-medium">1. Install the client</h3>
            <p className="text-muted-foreground text-xs">
              Installs both the <code className="text-foreground">aprag</code> CLI and
              the <code className="text-foreground">aprag-mcp</code> MCP server (isolated
              env via <code className="text-foreground">pipx</code>).
            </p>
            <Code>{`pipx install "${REPO}"`}</Code>
            <p className="text-muted-foreground text-xs">
              They talk to the server at{" "}
              <code className="text-foreground">{SERVER_URL}</code> (set via{" "}
              <code className="text-foreground">APRAG_QUERY_URL</code>).
            </p>
          </section>

          {/* MCP */}
          <section className="space-y-2 rounded-xl border border-border/60 p-3.5">
            <div className="flex items-baseline justify-between">
              <h3 className="font-medium">Method A — MCP (for autonomous agents)</h3>
              <span className="text-muted-foreground text-xs">recommended</span>
            </div>
            <p className="text-muted-foreground text-xs">
              Gives the agent native tools it calls on its own:{" "}
              <code className="text-foreground">aprag_query</code> (synthesized,
              APA-cited answer), <code className="text-foreground">aprag_retrieve</code>{" "}
              (raw chunks for multi-hop reasoning), and{" "}
              <code className="text-foreground">aprag_search</code> (find papers by
              topic + metadata).
            </p>
            <p className="font-medium text-xs">Claude Code</p>
            <Code>{`claude mcp add --scope user aprag \\
  --env APRAG_QUERY_URL=${SERVER_URL} -- aprag-mcp`}</Code>
            <p className="font-medium text-xs">
              Codex / Gemini CLI / Cursor / other MCP clients
            </p>
            <Code>{`{
  "mcpServers": {
    "aprag": {
      "command": "aprag-mcp",
      "env": { "APRAG_QUERY_URL": "${SERVER_URL}" }
    }
  }
}`}</Code>
            <p className="text-muted-foreground text-xs">
              <span className="font-medium text-foreground">Strengths:</span> the agent
              decides <em>when</em> and <em>what</em> to retrieve, chains multiple
              retrievals (read chunks → follow a lead → retrieve again), and folds the
              evidence into its own reasoning. Best for deep, autonomous research.
            </p>
          </section>

          {/* CLI */}
          <section className="space-y-2 rounded-xl border border-border/60 p-3.5">
            <h3 className="font-medium">Method B — CLI (for quick / scripted use)</h3>
            <Code>{`aprag config set-server ${SERVER_URL}

aprag ask    "How does word frequency affect lexical decision times?"
aprag chunks "contextual diversity" --mode naive
aprag search "humor" --author Westbury --year-from 2015`}</Code>
            <p className="text-muted-foreground text-xs">
              <span className="font-medium text-foreground">Strengths:</span> instant
              one-off questions with human-readable, APA-cited output and clickable PDF
              links; fully scriptable and pipeable (<code className="text-foreground">--json | jq</code>);
              needs no agent — and an agent can always shell out to it for a single
              answer. Add <code className="text-foreground">aprag ask --help</code> for
              modes, reasoning, and filter flags.
            </p>
          </section>

          <p className="text-muted-foreground text-xs">
            <span className="font-medium text-foreground">Which?</span> Use <b>MCP</b> when
            you want the agent to research autonomously across many retrievals; use the{" "}
            <b>CLI</b> for fast, deterministic, human-driven lookups or scripts. They share
            one backend, so you can use both.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
