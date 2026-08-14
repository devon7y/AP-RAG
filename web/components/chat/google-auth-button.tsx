"use client";

import { useState } from "react";
import { loginWithGoogle } from "@/app/(auth)/actions";
import { Button } from "@/components/ui/button";
import { LoaderIcon } from "./icons";

function GoogleLogo() {
  return (
    <svg aria-hidden="true" height="16" viewBox="0 0 48 48" width="16">
      <path
        d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"
        fill="#4285F4"
      />
      <path
        d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"
        fill="#34A853"
      />
      <path
        d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24c0 3.55.85 6.91 2.34 9.88l7.35-5.7z"
        fill="#FBBC05"
      />
      <path
        d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"
        fill="#EA4335"
      />
    </svg>
  );
}

// The default way in: one click, and the account carries the person's Google name and
// photo into the share dialog and message bylines. The password form below stays as the
// fallback for accounts that predate Google sign-in.
export function GoogleAuthButton() {
  const [pending, setPending] = useState(false);

  return (
    <form
      action={async () => {
        setPending(true);
        try {
          await loginWithGoogle();
        } finally {
          // Only reached if the redirect failed (e.g. offline) — recover the button.
          setPending(false);
        }
      }}
    >
      <Button
        className="h-10 w-full gap-2.5 rounded-lg border-border/50 bg-muted/50 font-normal text-sm transition-colors hover:bg-muted"
        disabled={pending}
        type="submit"
        variant="outline"
      >
        {pending ? (
          <span className="animate-spin">
            <LoaderIcon size={16} />
          </span>
        ) : (
          <GoogleLogo />
        )}
        Continue with Google
      </Button>
    </form>
  );
}

export function AuthDivider() {
  return (
    <div className="flex items-center gap-3 py-1">
      <div className="h-px flex-1 bg-border/60" />
      <span className="text-muted-foreground text-xs">or</span>
      <div className="h-px flex-1 bg-border/60" />
    </div>
  );
}
