"use client";

// The "Agentic Tools" page — how to point your own agent, or your terminal, at this
// corpus.
//
// This replaces the old "Connect to your own agentic AI" dialog that lived in the chat
// header. A dialog had room for three tools and two sentences of explanation; the
// server now exposes nine MCP tools and seven CLI commands, the retrieval modes need
// explaining before anyone can choose one, and the setup has a real footgun (an MCP
// subprocess does not inherit your shell environment). That is a page, not a popover.

import {
  BookOpenIcon,
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  LayersIcon,
  type LucideIcon,
  PlugZapIcon,
  RouteIcon,
  ServerCogIcon,
  SquareTerminalIcon,
  StethoscopeIcon,
  WrenchIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { useCopyToClipboard } from "usehooks-ts";
import { PageShell } from "@/components/chat/page-header";
import { SidebarToggle } from "@/components/chat/sidebar-toggle";
import { cn } from "@/lib/utils";

// Public endpoint of the AP-RAG query server (Cloudflare Tunnel → the always-on PC).
const SERVER_URL = "https://rag-api.devon7y.com";
// The real key is never rendered here: this page ships to the browser, and the corpus
// is exactly what the key protects. Readers get it from Devon and paste it in.
const KEY_PLACEHOLDER = "<your-key>";
const REPO = "git+https://github.com/devon7y/AP-RAG.git";

const SECTIONS = [
  { id: "overview", label: "What this is" },
  { id: "setup", label: "Setup" },
  { id: "mcp", label: "MCP server" },
  { id: "tools", label: "The nine tools" },
  { id: "cli", label: "CLI" },
  { id: "modes", label: "Retrieval modes" },
  { id: "pipeline", label: "Under the hood" },
  { id: "troubleshooting", label: "Troubleshooting" },
];

// ── Small building blocks ───────────────────────────────────────────────────

function C({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11.5px] text-foreground">
      {children}
    </code>
  );
}

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
        className="absolute top-1.5 right-1.5 rounded-md p-1.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
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

function Section({
  id,
  icon: Icon,
  title,
  lede,
  children,
}: {
  id: string;
  icon: LucideIcon;
  title: string;
  lede?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      className="scroll-mt-4 rounded-xl border border-border bg-card/60 p-4"
      id={id}
    >
      <div className="mb-1 flex items-center gap-2">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <h2 className="font-medium text-sm">{title}</h2>
      </div>
      {lede ? (
        <p className="mb-4 text-muted-foreground text-xs leading-relaxed">
          {lede}
        </p>
      ) : null}
      <div className="space-y-5">{children}</div>
    </section>
  );
}

function Sub({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <h3 className="font-medium text-[13px]">{title}</h3>
      {children}
    </div>
  );
}

function P({ children }: { children: ReactNode }) {
  return (
    <p className="text-muted-foreground text-xs leading-relaxed">{children}</p>
  );
}

// A labelled row used for the tool reference, the CLI commands and the filters —
// one grid so the three tables read as the same object seen three ways.
function Row({
  name,
  note,
  children,
}: {
  name: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-x-4 gap-y-1 border-border/50 border-t py-2.5 first:border-t-0 first:pt-0 sm:grid-cols-[minmax(9.5rem,auto)_1fr]">
      <div className="min-w-0">
        <code className="font-mono text-[12px] text-foreground">{name}</code>
        {note ? (
          <div className="text-[11px] text-muted-foreground/80">{note}</div>
        ) : null}
      </div>
      <div className="text-muted-foreground text-xs leading-relaxed">
        {children}
      </div>
    </div>
  );
}

function Callout({
  tone = "default",
  children,
}: {
  tone?: "default" | "warn";
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border px-3 py-2 text-xs leading-relaxed",
        tone === "warn"
          ? "border-amber-500/30 bg-amber-500/[0.06] text-foreground/90"
          : "border-border/60 bg-muted/30 text-muted-foreground"
      )}
    >
      {children}
    </div>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

export function AgenticTools() {
  return (
    <PageShell
      className="overflow-y-auto"
      header={
        <>
          <SidebarToggle />
          <PlugZapIcon className="size-4 text-muted-foreground" />
          <h1 className="font-semibold text-sm">Agentic Tools</h1>
          <span className="hidden text-muted-foreground text-xs sm:inline">
            MCP server + CLI over the same corpus
          </span>
        </>
      }
    >
      <div className="mx-auto w-full max-w-4xl space-y-4 px-4 pb-16">
        {/* ── Lede + table of contents ── */}
        <div className="space-y-3 pb-1">
          <p className="text-[13px] text-foreground leading-relaxed">
            Everything this web app does sits on one HTTP API. Two thin clients
            expose that same API outside the browser: an{" "}
            <strong className="font-medium">MCP server</strong>, so an agent
            (Claude Code, Codex, Cursor, Gemini CLI, anything MCP-capable) can
            research the corpus on its own initiative, and a{" "}
            <strong className="font-medium">CLI</strong>, for one-off questions
            and scripts. Both ship in one package, both hold no models and no
            data, and both answer from the identical index you see here.
          </p>
          <nav className="flex flex-wrap gap-1.5">
            {SECTIONS.map((s) => (
              <a
                className="rounded-lg border border-border/60 bg-muted/30 px-2.5 py-1 text-[11.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                href={`#${s.id}`}
                key={s.id}
              >
                {s.label}
              </a>
            ))}
          </nav>
        </div>

        {/* ── What this is ── */}
        <Section
          icon={ServerCogIcon}
          id="overview"
          lede="Your machine runs zero models and stores zero papers. The client is a
          few hundred lines of Python that forwards a request and formats what comes
          back; every expensive part — the knowledge graph, the vector index, the
          embedding model, the answer LLM — lives on the server."
          title="What this is"
        >
          <Code>{`your machine
└── aprag package
    ├── aprag       (CLI — you type)          ─┐
    └── aprag-mcp   (MCP server — agent calls)─┤
                                               │  HTTPS + X-API-Key
                                               ▼
                                      ${SERVER_URL}
                                               │
   ┌───────────────────────────────────────────┴──────────────────┐
   │  query server (FastAPI)                                      │
   │   ├── LightRAG knowledge graph  (entities + relationships)   │
   │   ├── Qdrant vector DB          (4096-dim chunk embeddings)  │
   │   ├── local embedding model     (query + chunk vectors)      │
   │   ├── papers_metadata.json      (APA7 records, filters)      │
   │   └── gpt-5-mini                (answer synthesis only)      │
   └──────────────────────────────────────────────────────────────┘`}</Code>
          <P>
            The split matters for how you use it. Retrieval — vector search,
            graph traversal, metadata filtering, page lookup — is cheap and
            deterministic, so an agent can call it dozens of times in a session.
            Synthesis is the only step that runs an LLM on the server, and it is
            optional: <C>aprag_retrieve</C> and <C>aprag chunks</C> hand you the
            raw passages and let your own model do the reasoning, which is
            usually what you want when the agent is already good at reading.
          </P>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-border/60 p-3">
              <div className="mb-1 flex items-center gap-1.5">
                <PlugZapIcon className="size-3.5 text-muted-foreground" />
                <span className="font-medium text-[13px]">MCP</span>
                <span className="text-[11px] text-muted-foreground">
                  for autonomous agents
                </span>
              </div>
              <P>
                The agent gets nine native tools and decides itself when to
                retrieve, what to retrieve, and when it has enough. It can chain
                hops — read chunks, follow an entity into the graph, pull the
                papers that entity came from, verify a quote is really on page 7
                — without you writing the loop.
              </P>
            </div>
            <div className="rounded-lg border border-border/60 p-3">
              <div className="mb-1 flex items-center gap-1.5">
                <SquareTerminalIcon className="size-3.5 text-muted-foreground" />
                <span className="font-medium text-[13px]">CLI</span>
                <span className="text-[11px] text-muted-foreground">
                  for humans and scripts
                </span>
              </div>
              <P>
                One command, one answer, rendered as markdown in the terminal
                with APA7 citations and clickable PDF links. Deterministic,
                pipeable (<C>--json | jq</C>), and callable from a shell script,
                a Makefile, or an agent that just wants one answer without
                installing anything else.
              </P>
            </div>
          </div>
          <P>
            They share one backend and one config, so using both is normal: ask
            the agent to research, then check a specific claim yourself from the
            terminal.
          </P>
        </Section>

        {/* ── Setup ── */}
        <Section
          icon={DownloadIcon}
          id="setup"
          lede="Four steps, the same for both clients. You need Python 3.10 or newer;
          nothing else is required on your machine."
          title="Setup"
        >
          <Sub title="1. Install the package">
            <P>
              This puts two console scripts on your PATH: <C>aprag</C> (the CLI)
              and <C>aprag-mcp</C> (the MCP server). <C>pipx</C> is recommended
              because it installs into its own isolated environment, so the
              client cannot collide with whatever else your Python has.
            </P>
            <Code>{`pipx install "${REPO}"

# or, into an environment you manage yourself:
pip install "${REPO}"`}</Code>
            <P>
              Verify with <C>aprag --version</C>. If you have the repo checked
              out already, <C>pip install -e .</C> from its root does the same
              thing against your working copy.
            </P>
          </Sub>

          <Sub title="2. Point it at the server">
            <P>
              The server URL resolves in this order: <C>--server URL</C> then{" "}
              <C>--local</C> then <C>$APRAG_QUERY_URL</C> then the config file
              then <C>http://localhost:8001</C>. The config file is the one that
              survives new shells, cron jobs and GUI apps, so set that:
            </P>
            <Code>{`aprag config set-server ${SERVER_URL}
aprag config show     # prints the resolved URL and every source, in precedence order`}</Code>
            <P>
              It writes <C>APRAG_QUERY_URL={SERVER_URL}</C> to{" "}
              <C>~/.config/aprag/config</C> (override the location with{" "}
              <C>$APRAG_CONFIG</C>).
            </P>
          </Sub>

          <Sub title="3. Set the access key">
            <P>
              The server is on a public address, so every request carries a
              shared secret in an <C>X-API-Key</C> header. The client sends it
              automatically whenever <C>$APRAG_API_KEY</C> is set; without it
              the data endpoints return <C>401 unauthorized</C>. Ask Devon for
              the key.
            </P>
            <Code>{`export APRAG_API_KEY=${KEY_PLACEHOLDER}     # add to ~/.zshrc or ~/.bashrc to persist`}</Code>
            <Callout tone="warn">
              Keep the key out of anything public — it grants full-text access
              to the whole corpus. And note that an MCP server launched by a GUI
              client does <strong>not</strong> read your shell profile: put the
              key in the MCP configuration block instead (below), not only in{" "}
              <C>~/.zshrc</C>.
            </Callout>
          </Sub>

          <Sub title="4. Check it works">
            <P>
              <C>aprag health</C> prints the server JSON: <C>retrieval_ready</C>{" "}
              tells you whether the vector store and the embedding service are
              actually up, <C>manifest_papers</C> how many bibliographic records
              are loaded, and <C>page_aware</C> whether the store carries
              per-chunk PDF page numbers.
            </P>
            <Code>{`aprag health
aprag ask "what predicts how funny a word is?"`}</Code>
          </Sub>

          <Sub title="Optional: clickable local PDFs">
            <P>
              Citations resolve to a PDF in a fixed fallback order:{" "}
              <strong className="text-foreground">local file</strong> then{" "}
              <strong className="text-foreground">Google Drive link</strong>{" "}
              then the lab share path then the bare filename. The local step
              runs entirely on your machine — the server cannot see your disk —
              by matching the citation filename against PDFs it finds in your
              paper directories. Point it at yours:
            </P>
            <Code>{`export APRAG_PAPERS_DIR="$HOME/Zotero:$HOME/Papers"   # os.pathsep-separated
export APRAG_LINK_STYLE="bold bright_cyan underline"  # terminal link colour (rich style)`}</Code>
            <P>
              With no value set it looks in <C>~/Zotero</C>,{" "}
              <C>~/Documents/papers</C>, <C>~/Papers</C> and <C>~/Downloads</C>.
              A Google Drive for Desktop mount counts as a local directory, so
              adding it makes every paper in the shared corpus open in one
              click. Per-call overrides: <C>--papers-dir DIR</C> to add one, and{" "}
              <C>--no-local</C> to skip the local scan entirely.
            </P>
          </Sub>
        </Section>

        {/* ── MCP ── */}
        <Section
          icon={PlugZapIcon}
          id="mcp"
          lede="MCP (Model Context Protocol) is how an agent picks up tools it was not
          built with. Your client launches aprag-mcp as a subprocess and talks JSON-RPC
          to it over stdin/stdout; the subprocess forwards to the query server. Nothing
          listens on a port, nothing runs when the agent is idle."
          title="MCP server"
        >
          <Sub title="Register it — Claude Code">
            <Code>{`claude mcp add --scope user aprag \\
  --env APRAG_QUERY_URL=${SERVER_URL} \\
  --env APRAG_API_KEY=${KEY_PLACEHOLDER} \\
  -- aprag-mcp

claude mcp list      # expect: aprag: aprag-mcp - ✔ Connected`}</Code>
          </Sub>

          <Sub title="Register it — Codex, Cursor, Gemini CLI, and other clients">
            <P>
              Anything that takes the standard <C>mcp.json</C> shape uses the
              same block. Cursor reads <C>~/.cursor/mcp.json</C>, Codex{" "}
              <C>~/.codex/config.json</C>, Gemini CLI{" "}
              <C>~/.gemini/settings.json</C>.
            </P>
            <Code>{`{
  "mcpServers": {
    "aprag": {
      "command": "aprag-mcp",
      "env": {
        "APRAG_QUERY_URL": "${SERVER_URL}",
        "APRAG_API_KEY": "${KEY_PLACEHOLDER}",
        "APRAG_PAPERS_DIR": "/Users/you/Zotero"
      }
    }
  }
}`}</Code>
            <Callout>
              If the client cannot find <C>aprag-mcp</C>, give it the absolute
              path — run <C>which aprag-mcp</C> (pipx installs to{" "}
              <C>~/.local/bin/aprag-mcp</C>) and use that as{" "}
              <C>&quot;command&quot;</C>. A GUI app inherits a minimal PATH, so
              this is the usual first failure.
            </Callout>
          </Sub>

          <Sub title="How the tools behave">
            <P>
              Four conventions run through all nine, and they exist because the
              obvious alternatives quietly mislead a model:
            </P>
            <ul className="ml-4 list-disc space-y-1.5 text-muted-foreground text-xs leading-relaxed marker:text-muted-foreground/50">
              <li>
                <strong className="text-foreground">
                  A filter that matches nothing is an error, not an empty
                  result.
                </strong>{" "}
                A misspelled author used to come back as &quot;0 papers
                found&quot;, indistinguishable from a real gap in the corpus —
                so the agent would confidently report that the lab never studied
                something. Filter values are checked against the corpus first,
                and a mismatch raises with &quot;did you mean&quot; suggestions.
              </li>
              <li>
                <strong className="text-foreground">Failures raise.</strong>{" "}
                Errors are returned as protocol errors (<C>isError</C>), never
                as prose that reads like an answer, so an outage cannot be
                mistaken for a finding.
              </li>
              <li>
                <strong className="text-foreground">
                  Every result is both text and data.
                </strong>{" "}
                Each call returns formatted, citation-carrying text for the
                model to read <em>and</em> <C>structuredContent</C> — chunks,
                entities, references, scores — for code to consume.
              </li>
              <li>
                <strong className="text-foreground">
                  Everything is read-only.
                </strong>{" "}
                All nine are annotated <C>readOnlyHint</C> and{" "}
                <C>idempotentHint</C>, so agents can call them freely and
                clients need not prompt for confirmation. Long calls report
                progress.
              </li>
            </ul>
          </Sub>

          <Sub title="The loop this is designed for">
            <P>
              <C>aprag_retrieve</C> is stateless: each call retrieves
              independently and the server remembers nothing, so the agent
              accumulates and deduplicates the evidence itself. That is the
              point — it makes multi-hop research a loop the agent controls:
            </P>
            <Code>{`1.  aprag_corpus(facet="authors", q="Westbury")     → exact name to filter on
2.  aprag_retrieve("humor and incongruity", mode="local")
                                                    → chunks + entities
3.  aprag_graph(action="entity", name="Semantic Neighbourhood Density")
                                                    → definition, links, source papers
4.  aprag_retrieve("neighbourhood density funniness", mode="naive",
                   authors=["Westbury, Chris"])     → scoped second hop
5.  aprag_similar(filename="Westbury_2016.pdf")     → adjacent work it missed
6.  aprag_locate(filename="Westbury_2016.pdf",
                 quote="…")                         → the page to cite`}</Code>
            <P>
              Steps 1 and 6 are the ones people skip and then regret: step 1
              stops the agent inventing a filter value, and step 6 is how it
              proves a quote it is about to attribute really appears in that
              PDF.
            </P>
          </Sub>
        </Section>

        {/* ── Tool reference ── */}
        <Section
          icon={WrenchIcon}
          id="tools"
          lede="Three retrieval tools, two discovery tools, four exploration tools. All
          of them accept the metadata filters listed at the end."
          title="The nine tools"
        >
          <Sub title="Retrieval">
            <div>
              <Row name="aprag_query" note="question, mode, reasoning">
                A finished, written answer with APA7 in-text citations and a
                references list. The server retrieves, gpt-5-mini synthesizes,
                and the citations are rewritten from the bibliographic manifest.
                Raise <C>reasoning</C> (<C>none</C> to <C>xhigh</C>) for hard
                questions at the cost of latency. Use it when you want the
                answer; use <C>aprag_retrieve</C> when you want the evidence.
              </Row>
              <Row
                name="aprag_retrieve"
                note="question, mode, top_k, chunk_top_k"
              >
                The raw material: the text chunks retrieval surfaced, plus the
                entities and relationships in graph modes.{" "}
                <strong className="text-foreground">No LLM runs.</strong> This
                is the multi-hop primitive — read the chunks, pick a lead, call
                again with a refined question or a different mode. Each chunk
                carries its paper, its reference and its PDF page.
              </Row>
              <Row name="aprag_search" note="question, top_k">
                Ranked <em>papers</em>, not an answer: semantic relevance to the
                topic combined with hard metadata filters. Each hit is an APA7
                citation, a link and a snippet. This is the &quot;find me the
                papers about X by Y&quot; tool.
              </Row>
            </div>
          </Sub>

          <Sub title="Discovery">
            <div>
              <Row name="aprag_corpus" note="facet, q, limit">
                What the filters actually accept — the antidote to guessing.
                Facets: <C>authors</C>, <C>journals</C>, <C>subjects</C>,{" "}
                <C>keywords</C>, <C>affiliations</C>, <C>types</C>, plus{" "}
                <C>stats</C> (corpus size) and <C>health</C> (is retrieval up).
                The author facet resolves people rather than surnames: each row
                gives the exact string to send back plus the papers, years and
                venue that disambiguate two authors who share a surname.
              </Row>
              <Row
                name="aprag_papers"
                note="filename | q, sort, order, offset, limit"
              >
                The corpus as a table, or one paper&apos;s full record
                (abstract, DOI, venue, subjects, keywords, affiliations) by
                filename. Pure metadata, no semantic ranking — it answers
                &quot;what does the corpus hold?&quot; questions such as every
                2024 paper in a journal. It also keeps working when the vector
                store or embedding service is down, which makes it the fallback
                when retrieval fails.
              </Row>
            </div>
          </Sub>

          <Sub title="Exploration">
            <div>
              <Row name="aprag_similar" note="filename, top_k">
                More like this. Ranks the corpus against a paper&apos;s mean
                chunk vector, excluding its own chunks, so neighbours come from
                overall content rather than a query you had to phrase. Good for
                growing a reading list from one known-good paper.
              </Row>
              <Row name="aprag_locate" note="filename, quote, hint_page">
                Which page of a PDF a quoted passage actually sits on — the
                citation-verification primitive. A miss returns <C>page=null</C>
                , which is evidence the quote may be paraphrased, altered or
                from a different paper. Scanned pages can also defeat text
                extraction, so a miss means &quot;unconfirmed&quot;, not
                &quot;fabricated&quot;.
              </Row>
              <Row
                name="aprag_graph"
                note="action, q, name, entity_type, file, limit"
              >
                The knowledge graph built over the corpus.{" "}
                <C>action=&quot;search&quot;</C> finds entities by name, type or
                source paper (with <C>file=</C> it answers &quot;what concepts
                does this paper cover?&quot;); <C>action=&quot;entity&quot;</C>{" "}
                opens one card — consolidated description, strongest
                connections, and the papers it was extracted from, which turns a
                name that appeared in a chunk into a reading list;{" "}
                <C>action=&quot;overview&quot;</C> gives graph size and top
                entity types.
              </Row>
              <Row name="aprag_trends" note="dim, term, limit">
                Corpus-wide publication trends: what is rising, fading, new or
                bursting, and per-year output. With <C>dim</C> and <C>term</C>{" "}
                it explains one term — co-occurrences, who published it in each
                period, and where. It describes <em>this library</em>, which
                reflects what has been collected, not the field as a whole.
              </Row>
            </div>
          </Sub>

          <Sub title="Metadata filters (accepted by every retrieval and listing tool)">
            <div>
              <Row name="papers" note="list of filenames">
                Pin an exact set of papers; retrieval draws on{" "}
                <strong className="text-foreground">only</strong> these. The{" "}
                <C>.pdf</C> extension is optional.
              </Row>
              <Row name="authors" note="list">
                A surname (<C>Zhang</C>) means every author with it;{" "}
                <C>Family, Given</C> (<C>Zhang, Kechen</C>) means that one
                person. Look the exact form up with <C>aprag_corpus</C>.
              </Row>
              <Row name="year · year_from · year_to" note="int">
                Exact year, or an inclusive range.
              </Row>
              <Row name="date_from · date_to" note="YYYY[-MM[-DD]]">
                Precision-aware date bounds, for corpora where the full
                publication date is known rather than just the year.
              </Row>
              <Row
                name="journals · subjects · keywords · affiliations"
                note="list, substring"
              >
                Venue, field label, keyword and institution. Substring matches,
                OR within a dimension, AND across dimensions.
              </Row>
              <Row name="types" note="list, exact">
                Publication type — <C>article</C>, <C>chapter</C>, and so on.
              </Row>
            </div>
            <Callout>
              Filters are resolved against the bibliographic manifest into a set
              of filenames, and retrieval then runs as a vector query restricted
              to those files. So a filtered question is genuinely searching only
              that subset — not searching everything and discarding the rest
              afterwards.
            </Callout>
          </Sub>
        </Section>

        {/* ── CLI ── */}
        <Section
          icon={SquareTerminalIcon}
          id="cli"
          lede="Seven commands. Every one takes --server/--local, --json for machine-
          readable output, and the same metadata filters as the MCP tools (as repeatable
          flags)."
          title="CLI"
        >
          <div>
            <Row name="aprag ask" note="synthesized answer">
              The <C>aprag_query</C> equivalent. Renders markdown in the
              terminal with APA7 citations; reference links become clickable{" "}
              <C>file://</C> URLs where the PDF is on your machine.{" "}
              <C>--mode</C> (default <C>hybrid</C>), <C>--reasoning</C>,{" "}
              <C>--user-prompt</C> for extra instructions to the answer model,{" "}
              <C>--top-k</C>, <C>--chunk-top-k</C>, <C>--plain</C> for raw
              markdown.
            </Row>
            <Row name="aprag chunks" note="raw retrieval">
              The <C>aprag_retrieve</C> equivalent, printed as cited markdown:
              one bold header per chunk with the paper&apos;s APA citation, its
              page and an open-PDF link, then the text. <C>--mode</C> (default{" "}
              <C>naive</C>), <C>--entities</C> to also print graph entities and
              relationships.
            </Row>
            <Row name="aprag search" note="ranked papers">
              Metadata-filtered semantic search over papers. Each result is an
              APA7 citation with score, link, pages and a snippet.
            </Row>
            <Row name="aprag add" note="upload PDFs">
              Uploads PDFs for incremental ingest and streams each paper&apos;s
              stage (metadata → extracting → placing → done). New papers become
              searchable in chat, the Papers Database and the Atlas within
              minutes. <C>--no-watch</C> queues and exits.
            </Row>
            <Row name="aprag ingest-status" note="[job_id]">
              Lists ingest jobs, or dumps one job&apos;s detail as JSON.
            </Row>
            <Row name="aprag health" note="server status">
              The server&apos;s <C>/health</C> JSON — the first thing to run
              when something returns nothing.
            </Row>
            <Row name="aprag config" note="show | set-server URL">
              Shows the resolved server and every source that could set it, or
              persists a default.
            </Row>
          </div>

          <Sub title="Worked examples">
            <Code>{`# a cited answer, scoped to one researcher and the last decade
aprag ask "what predicts funniness?" --author Westbury --year-from 2015

# evidence instead of an answer, with the graph context, from one journal
aprag chunks "semantic neighbourhood density" --mode local --entities \\
  --journal Cognition --chunk-top-k 8

# find the papers, do not answer the question
aprag search "incongruity humor" --year-from 2015 --subject "Cognitive Psychology"

# pin the retrieval to two specific papers
aprag ask "how were the stimuli chosen?" --paper Westbury_2016 --paper Hollis_2018

# scriptable: count what came back, harvest the citations
aprag chunks "entropy" --json | jq '.data.chunks | length'
aprag ask "word frequency effects" --json | jq -r '.references[].apa'`}</Code>
            <P>
              Filter flags are repeatable and combine the same way as the MCP
              filters: <C>--paper</C>, <C>--author</C>, <C>--journal</C>,{" "}
              <C>--subject</C>, <C>--keyword</C>, <C>--affiliation</C>,{" "}
              <C>--year</C>, <C>--year-from</C>, <C>--year-to</C>,{" "}
              <C>--date-from</C>, <C>--date-to</C>. Full flag list:{" "}
              <C>aprag ask --help</C>.
            </P>
          </Sub>
        </Section>

        {/* ── Modes ── */}
        <Section
          icon={RouteIcon}
          id="modes"
          lede="Both clients take a mode, and it changes what retrieval means — vector
          search over passages, traversal of the knowledge graph, or both. Choosing
          badly is the most common reason a query comes back thin."
          title="Retrieval modes"
        >
          <div>
            <Row name="naive" note="chunks only">
              Plain semantic search: embed the question, return the nearest text
              chunks. No graph. Fastest and the most literal — best when you
              want passages that talk about the thing you asked about, and the
              default for <C>aprag chunks</C> and <C>aprag_retrieve</C>.
            </Row>
            <Row name="local" note="entity-centred">
              Finds the graph entities that match the question, then pulls their
              descriptions and the chunks they were extracted from. Good for
              specific leads: a method, a measure, a named effect, one
              study&apos;s details.
            </Row>
            <Row name="global" note="relationship-centred">
              Retrieves relationships and the entities they connect, rather than
              passages first. Good for broad, thematic questions — how two areas
              relate, what a line of work connects to — where the answer is
              spread across many papers and no single passage states it.
            </Row>
            <Row name="hybrid" note="local + global">
              Both graph directions together. The default for <C>aprag ask</C>{" "}
              and <C>aprag_query</C>, and the right first guess for a real
              research question.
            </Row>
            <Row name="mix" note="graph + vector">
              Graph retrieval combined with straight vector search, so
              passage-level detail is not lost to the graph&apos;s abstraction.
              The broadest and the slowest.
            </Row>
          </div>
          <P>
            Two knobs shape the volume: <C>top_k</C> caps the entities and
            relationships pulled from the graph, <C>chunk_top_k</C> caps the
            text chunks kept after reranking. Leave them unset to take the
            server&apos;s defaults; raise <C>chunk_top_k</C> when an answer
            feels under-evidenced, and lower it when you are feeding the chunks
            to a small context.
          </P>
          <Callout>
            Adding any metadata filter switches retrieval to the chunks-only
            path: passages from the matching papers, ranked by semantic
            relevance, with no graph step — a filtered answer is still
            synthesized, just from those chunks. The graph is corpus-wide and
            cannot be sliced per paper without losing what makes it useful, so a
            filter and a graph mode do not combine.
          </Callout>
        </Section>

        {/* ── Under the hood ── */}
        <Section
          icon={LayersIcon}
          id="pipeline"
          lede="Why the answers look the way they do — what happened to a PDF long
          before you asked anything, and what happens between your question and the
          text that comes back."
          title="Under the hood"
        >
          <Sub title="Ingest (batch, on GPU clusters)">
            <P>
              Each PDF is extracted with its page boundaries preserved, then
              chunked by a{" "}
              <strong className="text-foreground">
                structure-aware chunker
              </strong>{" "}
              rather than by a fixed token count: it splits on sections first,
              then paragraphs, then sentences; it distinguishes real section
              breaks from subsection headings such as Participants or Procedure;
              it strips running heads, mastheads and page numbers; it avoids
              false sentence breaks on abbreviations, decimals and initials; it
              isolates figure and table captions; it adds overlap only within a
              section; and it excludes the references and acknowledgements.
              Every chunk is stamped with the PDF page it starts on — that is
              where the page numbers in citations come from.
            </P>
            <P>
              Each chunk then gets a short LLM-written blurb situating it in its
              paper before it is embedded (contextual retrieval), which is what
              keeps a passage findable when it says &quot;this effect&quot;
              instead of naming it. The same LLM extracts entities and
              relationships under an academic schema — Author, Concept, Method,
              Theory, Dataset, Result, Experiment, Finding, Institution,
              Publication — and merges them into one knowledge graph across the
              corpus. Finally the chunks are embedded at 4096 dimensions and
              written to Qdrant.
            </P>
          </Sub>
          <Sub title="Query (live, on the server)">
            <P>
              Your question is embedded with the same model, then vector search
              and, in graph modes, graph traversal produce a candidate set that
              is reranked down to <C>chunk_top_k</C> chunks. <C>/retrieve</C>{" "}
              stops there and hands them back. <C>/query</C> passes them to
              gpt-5-mini, which writes an answer with numeric citations; the
              server then rewrites every <C>[n]</C> into an APA7 in-text
              citation and rebuilds the reference list from{" "}
              <C>papers_metadata.json</C> — a per-paper bibliographic record
              built from Crossref plus LLM extraction — attaching the PDF pages
              the cited passages came from.
            </P>
            <P>
              The client does the last step. The server can only offer a shared
              path or a Drive link, so <C>aprag</C> and <C>aprag-mcp</C> rewrite
              each reference to a <C>file://</C> link when they find that
              filename on your disk. Filenames are identical everywhere in the
              system, which is what makes the match reliable even though the
              paths differ on every machine.
            </P>
          </Sub>
          <Sub title="The wire protocol, if you would rather skip the client">
            <P>
              Everything above is four HTTP endpoints. Any language that can
              POST JSON can use the corpus directly:
            </P>
            <Code>{`curl -s ${SERVER_URL}/health -H "X-API-Key: $APRAG_API_KEY"

curl -s -X POST ${SERVER_URL}/query \\
  -H "Content-Type: application/json" -H "X-API-Key: $APRAG_API_KEY" \\
  -d '{"question":"what predicts funniness?","mode":"hybrid"}'

curl -s -X POST ${SERVER_URL}/retrieve \\
  -H "Content-Type: application/json" -H "X-API-Key: $APRAG_API_KEY" \\
  -d '{"question":"humor","mode":"naive","chunk_top_k":3}'

curl -s -X POST ${SERVER_URL}/search \\
  -H "Content-Type: application/json" -H "X-API-Key: $APRAG_API_KEY" \\
  -d '{"question":"meaning","filters":{"authors":["Westbury"]}}'`}</Code>
            <P>
              <C>/query</C> returns <C>{"{answer, references, mode}"}</C>;{" "}
              <C>/retrieve</C> returns entities, relationships, chunks and
              references; <C>/search</C> returns ranked papers. All three accept
              the same optional <C>filters</C> object. You lose the APA
              localisation and the &quot;did you mean&quot; filter validation,
              which is most of what the client is for.
            </P>
          </Sub>
        </Section>

        {/* ── Troubleshooting ── */}
        <Section
          icon={StethoscopeIcon}
          id="troubleshooting"
          lede="In rough order of how often each one is the actual problem."
          title="Troubleshooting"
        >
          <div>
            <Row name="401 unauthorized">
              <C>$APRAG_API_KEY</C> is unset or wrong{" "}
              <em>in the process making the request</em>. For MCP that is the
              subprocess your client launches, which does not read your shell
              profile — put the key in the <C>env</C> block of the MCP config.
            </Row>
            <Row name="aprag-mcp: command not found">
              The client&apos;s PATH does not include the install directory. Run{" "}
              <C>which aprag-mcp</C> and use the absolute path as the{" "}
              <C>command</C>.
            </Row>
            <Row name="Connection refused / timeout">
              The server is down or the URL is wrong. Check with{" "}
              <C>aprag config show</C>, then <C>aprag health</C>. If health
              hangs rather than failing, it is the server, not you.
            </Row>
            <Row name="Nothing came back">
              Distinguish two cases. A tool <em>error</em> naming a filter value
              means the filter matched no paper — take the suggestion. A
              genuinely empty result means retrieval ran and found nothing: try{" "}
              <C>mode=&quot;naive&quot;</C>, drop the filters, or check{" "}
              <C>aprag_corpus(facet=&quot;health&quot;)</C> for{" "}
              <C>retrieval_ready</C>.
            </Row>
            <Row name="The agent stopped seeing the tools">
              A stale server process. <C>pkill -f aprag-mcp</C> and retry — the
              client restarts it automatically.
            </Row>
            <Row name="No page numbers in citations">
              Pages exist only for papers ingested with the page-aware chunker;{" "}
              <C>/health</C> reports <C>page_aware</C>. Older material simply
              omits them, and in-text citations never carry pages.
            </Row>
          </div>
          <Callout>
            <span className="inline-flex items-center gap-1.5">
              <BookOpenIcon className="size-3.5 shrink-0" />
              Still stuck, or want access? Ask Devon — the key, the corpus
              contents and the server itself are all managed by hand.
            </span>
          </Callout>
        </Section>
      </div>
    </PageShell>
  );
}
