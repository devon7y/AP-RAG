"use server";

import { z } from "zod";

import { isEmailAllowed } from "@/lib/aprag/access";
import { createUser, getUser } from "@/lib/db/queries";

import { signIn } from "./auth";

// Registration enforces a valid email + a minimum password length.
const authFormSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

// Login only checks that both fields are present — length/format rules don't belong on a
// sign-in form (they would permanently lock out any account whose password is short or
// was created outside the register form). authorize() does the real credential check.
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
