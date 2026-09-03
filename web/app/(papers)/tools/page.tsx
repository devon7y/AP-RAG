import type { Metadata } from "next";
import { AgenticTools } from "@/components/tools/agentic-tools";

export const metadata: Metadata = {
  title: "Agentic Tools — AP-RAG",
  description:
    "Connect your own agent or terminal to the AP-RAG corpus: the aprag-mcp MCP server and the aprag CLI — setup, the nine tools, retrieval modes, and how the pipeline works.",
};

export default function AgenticToolsPage() {
  return <AgenticTools />;
}
