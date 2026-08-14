"use server";

import { z } from "zod";

import { isEmailAllowed } from "@/lib/aprag/access";
import { createUser, getUser } from "@/lib/db/queries";

import { signIn } from "./auth";

// Kicks off the Google OAuth redirect. signIn() throws Next's redirect control-flow
// "error", which the form action machinery handles — nothing to return.
export async function loginWithGoogle() {
  await signIn("google", {
    redirectTo: `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/`,
  });
}

// No password length limits — only require a valid email and a non-empty password.
const authFormSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// Login only checks that both fields are present; authorize() does the real credential
// check (allowlist + user lookup + bcrypt compare).
const loginFormSchema = z.object({
  email: z.string().min(1),
  password: z.string().min(1),
});

export type LoginActionState = {
  status: "idle" | "in_progress" | "success" | "failed" | "invalid_data";
};

export const login = async (
  _: LoginActionState,
  formData: FormData
): Promise<LoginActionState> => {
  try {
    const validatedData = loginFormSchema.parse({
      email: formData.get("email"),
      password: formData.get("password"),
    });

    await signIn("credentials", {
      email: validatedData.email,
      password: validatedData.password,
      redirect: false,
    });

    return { status: "success" };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { status: "invalid_data" };
    }

    return { status: "failed" };
  }
};

export type RegisterActionState = {
  status:
    | "idle"
    | "in_progress"
    | "success"
    | "failed"
    | "user_exists"
    | "invalid_data";
};

export const register = async (
  _: RegisterActionState,
  formData: FormData
): Promise<RegisterActionState> => {
  try {
    const validatedData = authFormSchema.parse({
      email: formData.get("email"),
      password: formData.get("password"),
    });

    // Private deployment: only allowlisted emails may create an account.
    if (!isEmailAllowed(validatedData.email)) {
      return { status: "failed" };
    }

    const [user] = await getUser(validatedData.email);

    if (user) {
      return { status: "user_exists" } as RegisterActionState;
    }
    await createUser(validatedData.email, validatedData.password);
    await signIn("credentials", {
      email: validatedData.email,
      password: validatedData.password,
      redirect: false,
    });

    return { status: "success" };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { status: "invalid_data" };
    }

    return { status: "failed" };
  }
};
