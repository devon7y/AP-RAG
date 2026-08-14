"use client";

import Link from "next/link";
import { useActionState, useEffect, useState } from "react";

import { AuthForm } from "@/components/chat/auth-form";
import {
  AuthDivider,
  GoogleAuthButton,
} from "@/components/chat/google-auth-button";
import { SubmitButton } from "@/components/chat/submit-button";
import { toast } from "@/components/chat/toast";
import { type LoginActionState, login } from "../actions";

export function LoginForm({ googleEnabled }: { googleEnabled: boolean }) {
  const [email, setEmail] = useState("");
  const [isSuccessful, setIsSuccessful] = useState(false);

  const [state, formAction] = useActionState<LoginActionState, FormData>(
    login,
    { status: "idle" }
  );

  // NextAuth reports OAuth failures by bouncing back here with ?error=. AccessDenied is
  // the allowlist saying no — the one a lab member might actually hit. Read from
  // window.location rather than searchParams/useSearchParams so the page stays fully
  // static under cacheComponents; the param is stripped after showing so a reload
  // doesn't re-toast.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const authError = params.get("error");
    if (!authError) {
      return;
    }
    toast({
      type: "error",
      description:
        authError === "AccessDenied"
          ? "That Google account isn't on the allowlist for this deployment."
          : "Google sign-in failed. Please try again.",
    });
    params.delete("error");
    const query = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}`
    );
  }, []);

  useEffect(() => {
    if (state.status === "failed") {
      toast({ type: "error", description: "Invalid credentials!" });
    } else if (state.status === "invalid_data") {
      toast({
        type: "error",
        description: "Failed validating your submission!",
      });
    } else if (state.status === "success") {
      setIsSuccessful(true);
      // Hard-navigate so the request re-runs the auth middleware with the freshly-set
      // session cookie and lands on the app. (router.refresh() alone can leave you
      // stranded on /login.)
      window.location.assign(`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/`);
    }
  }, [state.status]);

  const handleSubmit = (formData: FormData) => {
    setEmail(formData.get("email") as string);
    formAction(formData);
  };

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Welcome back</h1>
      <p className="text-sm text-muted-foreground">
        Sign in to your account to continue
      </p>
      {googleEnabled && (
        <div className="mt-4 flex flex-col gap-4">
          <GoogleAuthButton />
          <AuthDivider />
        </div>
      )}
      <AuthForm action={handleSubmit} defaultEmail={email}>
        <SubmitButton isSuccessful={isSuccessful}>Sign in</SubmitButton>
        <p className="text-center text-[13px] text-muted-foreground">
          {"No account? "}
          <Link
            className="text-foreground underline-offset-4 hover:underline"
            href="/register"
          >
            Sign up
          </Link>
        </p>
      </AuthForm>
    </>
  );
}
