"use client";

import { upload as uploadToBlob } from "@vercel/blob/client";
import {
  FileTextIcon,
  Loader2Icon,
  PlusIcon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import { type DragEvent, useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";
import type { UploadedPaperSummary } from "@/lib/aprag/types";
import {
  MAX_UPLOAD_BYTES,
  MAX_UPLOADS_PER_CHAT,
  UPLOAD_ACCEPT,
  uploadPdfName,
} from "@/lib/aprag/uploads";
import { usePdfViewer } from "@/lib/pdf/store";
import { cn, fetcher } from "@/lib/utils";
import { Button } from "../ui/button";

// "Upload papers" — bringing a paper that is NOT in the AP-RAG database into a chat.
//
// The papers belong to the CHAT, not to a single message: once one is attached, every
// following question is answered with its passages available alongside the corpus, and in
// a shared chat everyone in the conversation sees it. That is why this is a list beside
// the composer rather than a per-message attachment.

const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

function isPdf(file: File): boolean {
  return (
    file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")
  );
}

export type ChatUploads = {
  papers: UploadedPaperSummary[];
  /** File names currently being read, in upload order. */
  pending: string[];
  isUploading: boolean;
  upload: (files: File[]) => Promise<void>;
  remove: (id: string) => Promise<void>;
};

/**
 * The chat's uploaded papers, plus the actions that change them. Uploading is deliberately
 * sequential: reading a PDF is the slow part, the per-chat limit is enforced server-side
 * per request, and dropping five papers at once should queue rather than race.
 */
export function useChatUploads(chatId: string): ChatUploads {
  const { data, mutate } = useSWR<{ papers: UploadedPaperSummary[] }>(
    `${base}/api/uploads?chatId=${chatId}`,
    fetcher,
    { revalidateOnFocus: true, shouldRetryOnError: false }
  );
  const papers = useMemo(() => data?.papers ?? [], [data?.papers]);
  const [pending, setPending] = useState<string[]>([]);

  const upload = useCallback(
    async (files: File[]) => {
      const pdfs = files.filter(isPdf);
      const rejected = files.length - pdfs.length;
      if (rejected > 0) {
        toast.error(
          rejected === files.length
            ? "Only PDFs can be uploaded."
            : `Skipped ${rejected} file${rejected === 1 ? "" : "s"} — only PDFs can be uploaded.`
        );
      }
      if (pdfs.length === 0) {
        return;
      }

      const room = MAX_UPLOADS_PER_CHAT - papers.length - pending.length;
      if (room <= 0) {
        toast.error(
          `This chat already has ${MAX_UPLOADS_PER_CHAT} uploaded papers. Remove one first.`
        );
        return;
      }
      const queue = pdfs.slice(0, room);
      if (queue.length < pdfs.length) {
        toast.error(
          `Only ${room} more paper${room === 1 ? "" : "s"} can be attached to this chat.`
        );
      }

      for (const file of queue) {
        if (file.size > MAX_UPLOAD_BYTES) {
          toast.error(
            `${file.name} is too large (limit ${MAX_UPLOAD_BYTES / 1024 / 1024} MB).`
          );
          continue;
        }
        setPending((current) => [...current, file.name]);
        try {
          // Straight from the browser into blob storage. It cannot go through the API
          // route: a serverless function refuses a body over 4.5MB, and papers are
          // routinely bigger — that refusal is what used to surface as "couldn't read"
          // for every large PDF. /api/uploads then reads it back and does the work.
          const stored = await uploadToBlob(
            `chat-uploads/${chatId}/${file.name.replace(/[^\w.-]+/g, "_")}`,
            file,
            {
              access: "public",
              handleUploadUrl: `${base}/api/uploads/blob`,
              contentType: "application/pdf",
              clientPayload: JSON.stringify({ chatId }),
            }
          );

          const response = await fetch(`${base}/api/uploads`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chatId,
              url: stored.url,
              filename: file.name,
            }),
          });
          const payload = (await response.json().catch(() => ({}))) as {
            paper?: UploadedPaperSummary;
            error?: string;
          };
          if (!response.ok || !payload.paper) {
            // Always say something specific: a bare "couldn't read it" sent us hunting
            // through the PDF when the request had never reached the server at all.
            toast.error(
              payload.error ??
                `Couldn't read ${file.name} (server said ${response.status}).`
            );
            continue;
          }
          const added = payload.paper;
          await mutate(
            (current) => ({
              papers: [...(current?.papers ?? []), added],
            }),
            { revalidate: false }
          );
          // No success toast: the chip appearing above the composer, with the paper's
          // title in it, already says the upload worked.
        } catch (error) {
          toast.error(
            `Couldn't upload ${file.name}: ${(error as Error)?.message ?? "unknown error"}`
          );
        } finally {
          setPending((current) => {
            const next = [...current];
            const at = next.indexOf(file.name);
            if (at >= 0) {
              next.splice(at, 1);
            }
            return next;
          });
        }
      }
    },
    [chatId, mutate, papers.length, pending.length]
  );

  const remove = useCallback(
    async (id: string) => {
      // Optimistic: the paper leaves the composer at once, and a failed delete is put back
      // by the revalidation.
      await mutate(
        async (current) => {
          const response = await fetch(`${base}/api/uploads/${id}`, {
            method: "DELETE",
          });
          if (!response.ok) {
            throw new Error("delete failed");
          }
          return { papers: (current?.papers ?? []).filter((p) => p.id !== id) };
        },
        {
          optimisticData: (current) => ({
            papers: (current?.papers ?? []).filter((p) => p.id !== id),
          }),
          rollbackOnError: true,
          revalidate: true,
        }
      ).catch(() => toast.error("Couldn't remove that paper."));
    },
    [mutate]
  );

  return {
    papers,
    pending,
    isUploading: pending.length > 0,
    upload,
    remove,
  };
}

/** The composer's "Upload papers" control: a button over a PDF-only file input. */
export function UploadPapersButton({
  onFiles,
  disabled,
  busy,
  count,
  className,
}: {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
  busy?: boolean;
  count: number;
  className?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const full = count >= MAX_UPLOADS_PER_CHAT;

  return (
    <>
      <input
        accept={UPLOAD_ACCEPT}
        className="pointer-events-none fixed -top-4 -left-4 size-0.5 opacity-0"
        multiple
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = ""; // re-uploading the same file must fire onChange again
          if (files.length > 0) {
            onFiles(files);
          }
        }}
        ref={inputRef}
        tabIndex={-1}
        type="file"
      />
      {/* Icon-only, and it lives on the text-box line rather than in the control row
          below: "attach something" is a different kind of act from the retrieval controls,
          and a tenth labelled button in that row read as another filter. */}
      <Button
        aria-label="Upload papers (PDF)"
        className={cn(
          "h-7 w-7 shrink-0 rounded-lg p-0",
          count > 0 && "text-foreground",
          className
        )}
        data-testid="upload-papers-button"
        disabled={disabled || busy || full}
        onClick={(event) => {
          event.preventDefault();
          inputRef.current?.click();
        }}
        size="sm"
        title={
          full
            ? `A chat can hold ${MAX_UPLOADS_PER_CHAT} uploaded papers`
            : "Upload papers — PDFs that aren't in the database"
        }
        type="button"
        variant="ghost"
      >
        {busy ? (
          <Loader2Icon className="size-4 animate-spin" />
        ) : (
          <PlusIcon className="size-4" />
        )}
      </Button>
    </>
  );
}

/**
 * The papers attached to this chat, as removable chips above the composer. Clicking one
 * opens it in the reader — the same pane a citation opens, so an uploaded paper reads
 * exactly like a corpus paper.
 */
export function UploadedPapersRow({
  papers,
  pending,
  onRemove,
  isChatOwner,
}: {
  papers: UploadedPaperSummary[];
  pending: string[];
  onRemove: (id: string) => void;
  /** The chat's owner can remove any attached paper; everyone else, only their own. */
  isChatOwner?: boolean;
}) {
  const openPdf = usePdfViewer((s) => s.openPdf);
  if (papers.length === 0 && pending.length === 0) {
    return null;
  }

  return (
    <div
      className="flex w-full flex-row flex-wrap items-center gap-1.5 px-3 pt-3"
      data-testid="uploaded-papers"
    >
      {papers.map((paper) => (
        <span
          className="group flex max-w-[280px] items-center gap-1.5 rounded-lg border border-border/60 bg-muted/40 py-1 pr-1 pl-2 text-xs"
          key={paper.id}
          title={[
            paper.title || paper.filename,
            paper.intext ? `cited as (${paper.intext})` : "",
            `${paper.pageCount} page${paper.pageCount === 1 ? "" : "s"}`,
            paper.uploadedBy && !paper.isOwn
              ? `uploaded by ${paper.uploadedBy}`
              : "",
          ]
            .filter(Boolean)
            .join(" · ")}
        >
          <FileTextIcon className="size-3 shrink-0 text-muted-foreground" />
          <button
            className="truncate hover:underline"
            onClick={() =>
              openPdf({
                filename: uploadPdfName(paper.id),
                page: 1,
                label: paper.intext || paper.title || paper.filename,
              })
            }
            type="button"
          >
            {paper.title || paper.filename.replace(/\.pdf$/i, "")}
          </button>
          {(paper.isOwn || isChatOwner) && (
            <button
              aria-label={`Remove ${paper.title || paper.filename}`}
              className="rounded-sm p-0.5 text-muted-foreground/60 hover:text-foreground"
              onClick={() => onRemove(paper.id)}
              type="button"
            >
              <XIcon className="size-3" />
            </button>
          )}
        </span>
      ))}
      {pending.map((filename) => (
        <span
          className="flex max-w-[280px] items-center gap-1.5 rounded-lg border border-border/60 border-dashed py-1 pr-2 pl-2 text-muted-foreground text-xs"
          key={`pending-${filename}`}
        >
          <Loader2Icon className="size-3 shrink-0 animate-spin" />
          <span className="truncate">
            Reading {filename.replace(/\.pdf$/i, "")}…
          </span>
        </span>
      ))}
    </div>
  );
}

/** A drag carrying files, as opposed to selected text or a dragged link. */
function carriesFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

/**
 * Dropping PDFs anywhere on the composer uploads them. Drag events fire per element, so
 * the enter/leave pairs are counted rather than treated as a flag — otherwise moving the
 * pointer over a child of the drop target reads as leaving it.
 */
export function usePdfDropZone({
  onFiles,
  disabled,
}: {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
}) {
  const depth = useRef(0);
  const [isDragging, setIsDragging] = useState(false);

  const onDragEnter = useCallback(
    (event: DragEvent) => {
      if (disabled || !carriesFiles(event)) {
        return;
      }
      event.preventDefault();
      depth.current += 1;
      setIsDragging(true);
    },
    [disabled]
  );

  const onDragOver = useCallback(
    (event: DragEvent) => {
      if (disabled || !carriesFiles(event)) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    [disabled]
  );

  const onDragLeave = useCallback((event: DragEvent) => {
    if (!carriesFiles(event)) {
      return;
    }
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) {
      setIsDragging(false);
    }
  }, []);

  const onDrop = useCallback(
    (event: DragEvent) => {
      if (!carriesFiles(event)) {
        return;
      }
      event.preventDefault();
      depth.current = 0;
      setIsDragging(false);
      if (disabled) {
        return;
      }
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length > 0) {
        onFiles(files);
      }
    },
    [disabled, onFiles]
  );

  return {
    isDragging,
    dropProps: { onDragEnter, onDragOver, onDragLeave, onDrop },
  };
}

/** The "drop here" state drawn over the composer while PDFs are being dragged onto it. */
export function PdfDropOverlay() {
  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-2xl border-2 border-primary/40 border-dashed bg-background/80 backdrop-blur-[1px]">
      <span className="flex items-center gap-2 font-medium text-[13px] text-foreground">
        <UploadIcon className="size-4" />
        Drop PDFs to add them to this chat
      </span>
    </div>
  );
}
