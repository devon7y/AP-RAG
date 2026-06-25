// Single-account lock for this private deployment. AUTH_ALLOWED_EMAILS is a
// comma-separated allowlist of addresses permitted to register/sign in. When it's unset
// (local dev) the gate is open; set it in production to lock the site to your account.
export function isEmailAllowed(email: string): boolean {
  const raw = process.env.AUTH_ALLOWED_EMAILS;
  if (!raw || !raw.trim()) {
    return true;
  }
  const allowed = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(email.trim().toLowerCase());
}
