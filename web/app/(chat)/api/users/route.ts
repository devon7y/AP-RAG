import { auth } from "@/app/(auth)/auth";
import { isEmailAllowed } from "@/lib/aprag/access";
import { getShareableUsers } from "@/lib/db/queries";
import { ChatbotError } from "@/lib/errors";

// The share dialog's candidate list: everyone who could open a chat you shared with them.
// This deployment is locked to an allowlist, so "every registered account" IS the lab —
// the list is a handful of people, and it's filtered against the current allowlist so a
// revoked address isn't offered.
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return new ChatbotError("unauthorized:chat").toResponse();
  }

  const users = await getShareableUsers({ excludeUserId: session.user.id });

  return Response.json({
    users: users.filter((u) => isEmailAllowed(u.email)),
  });
}
