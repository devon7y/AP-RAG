import { googleAuthEnabled } from "../auth";
import { LoginForm } from "./login-form";

// Server wrapper: whether Google sign-in exists is decided by env vars the client
// can't see. (The ?error= param NextAuth bounces back with is read client-side in
// LoginForm — awaiting searchParams here would make the page dynamic, which
// cacheComponents rejects at build time for a page without a Suspense boundary.)
export default function Page() {
  return <LoginForm googleEnabled={googleAuthEnabled} />;
}
