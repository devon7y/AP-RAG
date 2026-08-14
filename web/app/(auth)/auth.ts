import { compare } from "bcrypt-ts";
import NextAuth, { type DefaultSession } from "next-auth";
import type { DefaultJWT } from "next-auth/jwt";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { isEmailAllowed } from "@/lib/aprag/access";
import { DUMMY_PASSWORD } from "@/lib/constants";
import { getUser, upsertGoogleUser } from "@/lib/db/queries";
import { authConfig } from "./auth.config";

// Google sign-in is the default path when AUTH_GOOGLE_ID/AUTH_GOOGLE_SECRET are set;
// the login page hides the button when they aren't, so a deployment without a Google
// OAuth client keeps working on passwords alone.
export const googleAuthEnabled = Boolean(
  process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET
);

export type UserType = "guest" | "regular";

declare module "next-auth" {
  interface Session extends DefaultSession {
    user: {
      id: string;
      type: UserType;
    } & DefaultSession["user"];
  }

  interface User {
    id?: string;
    email?: string | null;
    type: UserType;
  }
}

declare module "next-auth/jwt" {
  interface JWT extends DefaultJWT {
    id: string;
    type: UserType;
  }
}

export const {
  handlers: { GET, POST },
  auth,
  signIn,
  signOut,
} = NextAuth({
  ...authConfig,
  providers: [
    ...(googleAuthEnabled ? [Google] : []),
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const email = String(credentials.email ?? "");
        const password = String(credentials.password ?? "");

        // Lock to the allowlisted account(s) for this private deployment.
        if (!isEmailAllowed(email)) {
          await compare(password, DUMMY_PASSWORD);
          return null;
        }

        const users = await getUser(email);

        if (users.length === 0) {
          await compare(password, DUMMY_PASSWORD);
          return null;
        }

        const [user] = users;

        if (!user.password) {
          await compare(password, DUMMY_PASSWORD);
          return null;
        }

        const passwordsMatch = await compare(password, user.password);

        if (!passwordsMatch) {
          return null;
        }

        return { ...user, type: "regular" };
      },
    }),
    // Guest access removed: this is a private, single-account deployment.
  ],
  callbacks: {
    // With Google there is no register step — this callback IS the gate. Anyone with a
    // Google account reaches it, so the allowlist check here is what keeps the
    // deployment private.
    signIn({ account, profile }) {
      if (account?.provider === "google") {
        const email = profile?.email;
        if (!email || profile?.email_verified === false) {
          return false;
        }
        return isEmailAllowed(email);
      }
      return true; // credentials: authorize() already checked the allowlist + password
    },
    async jwt({ token, user, account, profile }) {
      // Google sign-in: the incoming user.id is Google's subject, not ours. Upsert the
      // account row (creating it on first sign-in, refreshing name/photo after) and put
      // OUR uuid in the token — every FK in the app (chats, votes, uploads, memberships)
      // hangs off it. Runs only on the sign-in request, not on session reads.
      if (account?.provider === "google" && profile?.email) {
        const dbUser = await upsertGoogleUser({
          email: profile.email,
          name: profile.name ?? null,
          image: typeof profile.picture === "string" ? profile.picture : null,
        });
        token.id = dbUser.id;
        token.type = "regular";
        return token;
      }

      if (user) {
        token.id = user.id as string;
        token.type = user.type;
      }

      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.id;
        session.user.type = token.type;
      }

      return session;
    },
  },
});
