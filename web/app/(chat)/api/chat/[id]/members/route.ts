import { z } from "zod";
import { auth } from "@/app/(auth)/auth";
import { isEmailAllowed } from "@/lib/aprag/access";
import {
  addChatMember,
  getChatParticipants,
  getUser,
  removeChatMember,
  resolveChatAccess,
  updateChatVisibilityById,
} from "@/lib/db/queries";
import { ChatbotError } from "@/lib/errors";

const addSchema = z.object({
  // Either identifies the invitee. Email is what the share dialog sends when the user
  // types an address; userId is what the picker sends for a known account.
  userId: z.string().uuid().optional(),
  email: z.string().email().optional(),
});

const removeSchema = z.object({
  userId: z.string().uuid(),
});

// Who currently has access. Any participant may see the roster — you should be able to
// tell who is reading along before you post.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const session = await auth();
  if (!session?.user?.id) {
    return new ChatbotError("unauthorized:chat").toResponse();
  }

  const access = await resolveChatAccess({
    chatId: id,
    userId: session.user.id,
  });
  if (!access) {
    return new ChatbotError("not_found:chat").toResponse();
  }
  if (!access.canRead) {
    return new ChatbotError("forbidden:chat").toResponse();
  }

  const participants = await getChatParticipants({ chatId: id });
  return Response.json({ participants, isOwner: access.isOwner });
}

// Invite someone. Owner only — a member can read and post but can't widen the circle.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let body: z.infer<typeof addSchema>;
  try {
    body = addSchema.parse(await request.json());
  } catch {
    return new ChatbotError(
      "bad_request:api",
      "Provide a userId or an email."
    ).toResponse();
  }

  const session = await auth();
  if (!session?.user?.id) {
    return new ChatbotError("unauthorized:chat").toResponse();
  }

  const access = await resolveChatAccess({
    chatId: id,
    userId: session.user.id,
  });
  if (!access) {
    return new ChatbotError("not_found:chat").toResponse();
  }
  if (!access.isOwner) {
    return new ChatbotError(
      "forbidden:chat",
      "Only the chat owner can change who it is shared with."
    ).toResponse();
  }

  let targetId = body.userId ?? null;

  if (!targetId && body.email) {
    // The deployment is allowlist-gated, so refuse an address that could never sign in
    // rather than creating a membership row nobody can ever use.
    if (!isEmailAllowed(body.email)) {
      return new ChatbotError(
        "bad_request:api",
        "That address isn't allowed to sign in to this deployment."
      ).toResponse();
    }
    const [found] = await getUser(body.email);
    if (!found) {
      return new ChatbotError(
        "not_found:chat",
        "No account with that email has signed in yet."
      ).toResponse();
    }
    targetId = found.id;
  }

  if (!targetId) {
    return new ChatbotError(
      "bad_request:api",
      "Provide a userId or an email."
    ).toResponse();
  }

  // The owner is already a participant by virtue of owning it.
  if (targetId !== access.chat.userId) {
    await addChatMember({ chatId: id, userId: targetId });
  }

  // Sharing with a named person implies the chat is shared. A chat already set to
  // "public" stays public — narrowing that is an explicit choice in the dialog.
  if (access.chat.visibility === "private") {
    await updateChatVisibilityById({ chatId: id, visibility: "shared" });
  }

  const participants = await getChatParticipants({ chatId: id });
  return Response.json({ participants });
}

// Remove a member. The owner can remove anyone; a member can remove themselves (leave).
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let body: z.infer<typeof removeSchema>;
  try {
    body = removeSchema.parse(await request.json());
  } catch {
    return new ChatbotError(
      "bad_request:api",
      "Parameter userId is required."
    ).toResponse();
  }

  const session = await auth();
  if (!session?.user?.id) {
    return new ChatbotError("unauthorized:chat").toResponse();
  }

  const access = await resolveChatAccess({
    chatId: id,
    userId: session.user.id,
  });
  if (!access) {
    return new ChatbotError("not_found:chat").toResponse();
  }

  const isSelf = body.userId === session.user.id;
  if (!(access.isOwner || isSelf)) {
    return new ChatbotError(
      "forbidden:chat",
      "Only the chat owner can remove other participants."
    ).toResponse();
  }

  await removeChatMember({ chatId: id, userId: body.userId });

  // Dropping the last member returns a "shared" chat to private. A public chat is
  // unaffected — its audience was never the member list.
  const participants = await getChatParticipants({ chatId: id });
  if (
    access.chat.visibility === "shared" &&
    participants.filter((p) => !p.isOwner).length === 0
  ) {
    await updateChatVisibilityById({ chatId: id, visibility: "private" });
  }

  return Response.json({ participants });
}
