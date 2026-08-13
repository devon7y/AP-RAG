import type { ComponentProps } from "react";

import { type SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Button } from "../ui/button";
import { SidebarLeftIcon } from "./icons";

export function SidebarToggle({
  className,
}: ComponentProps<typeof SidebarTrigger>) {
  const { state, peek, toggleSidebar } = useSidebar();

  // Same rule the chat header follows: an expanded sidebar carries its own
  // collapse trigger, so showing a second one in the page header just
  // duplicates it. A peeking sidebar is only transiently expanded, so it still
  // counts as tucked — otherwise the button would flicker as the pointer passes.
  const sidebarTucked = peek || state === "collapsed";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          className={cn(className, !sidebarTucked && "md:hidden")}
          data-testid="sidebar-toggle-button"
          onClick={toggleSidebar}
          size="icon-sm"
          variant="outline"
        >
          <SidebarLeftIcon size={16} />
        </Button>
      </TooltipTrigger>
      <TooltipContent align="start" className="hidden md:block">
        Toggle Sidebar
      </TooltipContent>
    </Tooltip>
  );
}
