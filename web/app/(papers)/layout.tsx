import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Toaster } from "sonner";
import { AppSidebar } from "@/components/chat/app-sidebar";
import { PdfViewerHost } from "@/components/pdf/pdf-viewer";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { auth } from "../(auth)/auth";

// Same sidebar shell as the chat layout, but rendering the route's own page instead of
// ChatShell — full-page experiences (the Papers Database) that keep the app sidebar.
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<div className="flex h-dvh bg-sidebar" />}>
      <SidebarShell>{children}</SidebarShell>
    </Suspense>
  );
}

async function SidebarShell({ children }: { children: React.ReactNode }) {
  const [session, cookieStore] = await Promise.all([auth(), cookies()]);

  // Private deployment: require login before anything loads.
  if (!session?.user) {
    redirect(`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/login`);
  }

  const isCollapsed = cookieStore.get("sidebar_state")?.value === "false";

  return (
    <SidebarProvider defaultOpen={!isCollapsed}>
      <AppSidebar user={session?.user} />
      {/* min-w-0: let the inset shrink below its content's intrinsic width, so a wide
          table scrolls inside its own container instead of stretching the page. */}
      <SidebarInset className="min-w-0">
        <Toaster
          position="top-center"
          theme="system"
          toastOptions={{
            className:
              "!bg-card !text-foreground !border-border/50 !shadow-[var(--shadow-float)]",
          }}
        />
        {children}
        {/* The paper drawer's "Read PDF" and the graph/author pages open the same viewer. */}
        <PdfViewerHost />
      </SidebarInset>
    </SidebarProvider>
  );
}
