import { createClient } from "redis";

// Where the app's Redis connection string comes from.
//
// Redis is optional here — without it the chat still works, it just loses resumable
// streams (so a group chat's followers wait for the whole answer instead of watching it
// arrive) and IP rate limiting. What makes this worth a module is the NAME: Vercel's
// marketplace providers each set a different one. The official Redis integration writes
// REDIS_URL, Upstash's KV product writes KV_URL, and resumable-stream itself accepts
// either. Checking only REDIS_URL means provisioning the wrong provider leaves the app
// silently degraded with a perfectly good Redis attached — so check both, exactly as the
// library does.
export function getRedisUrl(): string | undefined {
  return process.env.REDIS_URL || process.env.KV_URL || undefined;
}

export function hasRedis(): boolean {
  return Boolean(getRedisUrl());
}

// A connected client, or a rejection: never a crash and never a hang. node-redis emits
// 'error' on a failed connect, and an 'error' with no listener is an uncaught exception.
// resumable-stream's default clients have no listener and start connecting the moment the
// context is made, while the chat route awaited two DB writes before handing it a stream.
// When the Redis host vanished (NXDOMAIN), DNS failed inside that gap and killed the
// function mid-answer: the reply stopped wherever it had got to (once inside a "[1"
// citation, which rendered as "1 [blocked]") and was never saved. Retries are off because
// a failed client otherwise keeps reconnecting and holds queued commands forever; these
// clients live for one request, so the next request simply tries again.
export async function connectRedis() {
  const client = createClient({
    url: getRedisUrl(),
    socket: { connectTimeout: 3000, reconnectStrategy: false },
  });
  client.on("error", () => undefined);
  await client.connect();
  return client;
}
