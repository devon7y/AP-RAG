"use client";

import { cn } from "@/lib/utils";

function emailToHue(email: string): number {
  let hash = 0;
  for (const char of email) {
    hash = char.charCodeAt(0) + ((hash << 5) - hash);
  }
  return Math.abs(hash) % 360;
}

function initials(person: { name?: string | null; email?: string | null }) {
  const name = person.name?.trim();
  if (name) {
    const parts = name.split(/\s+/);
    return (parts[0][0] + (parts.at(-1)?.[0] ?? "")).toUpperCase();
  }
  return (person.email ?? "?").slice(0, 2).toUpperCase();
}

// One avatar for everywhere a person appears: the Google profile photo when the account
// has one, otherwise their initials on the same email-keyed gradient the sidebar has
// always used — so password-only accounts keep a stable identity color.
export function UserAvatar({
  person,
  className,
}: {
  person: {
    name?: string | null;
    email?: string | null;
    image?: string | null;
  };
  className?: string;
}) {
  if (person.image) {
    return (
      // biome-ignore lint/performance/noImgElement: Google avatar URLs (lh3.googleusercontent.com) are already tiny and CDN-served; next/image optimization would only add a proxy hop and a remotePatterns entry. no-referrer avoids Google's hotlink 403s.
      <img
        alt=""
        className={cn(
          "shrink-0 rounded-full object-cover ring-1 ring-sidebar-border/50",
          className
        )}
        draggable={false}
        referrerPolicy="no-referrer"
        src={person.image}
      />
    );
  }

  const hue = emailToHue(person.email ?? "");
  return (
    <span
      className={cn(
        "flex shrink-0 select-none items-center justify-center rounded-full font-medium text-[9px] text-white/90 uppercase ring-1 ring-sidebar-border/50",
        className
      )}
      style={{
        background: `linear-gradient(135deg, oklch(0.35 0.08 ${hue}), oklch(0.25 0.05 ${hue + 40}))`,
      }}
    >
      {initials(person)}
    </span>
  );
}
