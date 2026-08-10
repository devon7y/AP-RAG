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
