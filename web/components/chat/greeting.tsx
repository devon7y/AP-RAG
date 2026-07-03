"use client";

import { motion } from "framer-motion";
import { useActiveChat } from "@/hooks/use-active-chat";
import { formatAuthorStat, useAuthorStats } from "@/lib/aprag/author-stats";

export const Greeting = () => {
  const { personaAuthor } = useActiveChat();
  const { byAuthor } = useAuthorStats();

  if (personaAuthor) {
    const stat = formatAuthorStat(byAuthor.get(personaAuthor));
    return (
      <div className="flex flex-col items-center px-4" key="overview">
        <motion.div
          animate={{ opacity: 1, y: 0 }}
          className="text-center font-semibold text-2xl tracking-tight text-foreground md:text-3xl"
          initial={{ opacity: 0, y: 10 }}
          transition={{ delay: 0.35, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        >
          Talk to {personaAuthor}
        </motion.div>
        <motion.div
          animate={{ opacity: 1, y: 0 }}
          className="mt-3 max-w-md text-center text-muted-foreground/80 text-sm"
          initial={{ opacity: 0, y: 10 }}
          transition={{ delay: 0.5, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        >
          Answers come only from {personaAuthor}&rsquo;s own papers
          {stat ? ` — ${stat}` : ""}. Every claim is cited, and they speak of a paper
          as their own only when they led it.
        </motion.div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center px-4" key="overview">
      <motion.div
        animate={{ opacity: 1, y: 0 }}
        className="text-center font-semibold text-2xl tracking-tight text-foreground md:text-3xl"
        initial={{ opacity: 0, y: 10 }}
        transition={{ delay: 0.35, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      >
        Ask the papers anything.
      </motion.div>
      <motion.div
        animate={{ opacity: 1, y: 0 }}
        className="mt-3 text-center text-muted-foreground/80 text-sm"
        initial={{ opacity: 0, y: 10 }}
        transition={{ delay: 0.5, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      >
        Get APA-cited answers from the corpus — hover any citation to see the exact
        passage it draws on.
      </motion.div>
    </div>
  );
};
