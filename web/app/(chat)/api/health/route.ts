import { auth } from "@/app/(auth)/auth";
import { getHealth } from "@/lib/aprag/client";

// Backend (query server) liveness for the header status dot. Behind auth; never throws.
export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return Response.json({ online: false }, { status: 401 });
  }
  return Response.json(await getHealth());
}
