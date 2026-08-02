import { auth } from "@/app/(auth)/auth";
import { getStats } from "@/lib/aprag/client";
import { getDigestChatsByUserId } from "@/lib/db/queries";

// The /digest library: every digest chat of the signed-in user (topic, window,
// last-run metadata) plus the corpus's current paper count, so the client can show
// "+N papers since last update" on open-ended digests.

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const [chats, stats] = await Promise.all([
      getDigestChatsByUserId({ id: session.user.id }),
      getStats().catch(() => null),
    ]);
    return Response.json({
      digests: chats.map((c) => ({
        chatId: c.id,
        title: c.title,
        createdAt: c.createdAt,
        digest: c.digest,
      })),
      papersNow: stats?.papers ?? null,
    });
  } catch {
    return Response.json({ error: "digests unavailable" }, { status: 502 });
  }
}
