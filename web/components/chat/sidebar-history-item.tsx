import {
  GlobeIcon as GlobeLucideIcon,
  LogOutIcon,
  UsersIcon,
} from "lucide-react";
import Link from "next/link";
import { memo, useState } from "react";
import { useChatVisibility } from "@/hooks/use-chat-visibility";
import type { Chat } from "@/lib/db/schema";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "../ui/sidebar";
import { MoreHorizontalIcon, ShareIcon, TrashIcon } from "./icons";
import { ShareDialog } from "./share-dialog";

const PureChatItem = ({
  chat,
  isActive,
  onDelete,
  onLeave,
  setOpenMobile,
}: {
  chat: Chat & { isOwner?: boolean };
  isActive: boolean;
  onDelete: (chatId: string) => void;
  // Present for chats shared WITH you: leaving drops your access, it doesn't delete
  // someone else's conversation (which the server would refuse anyway).
  onLeave?: (chatId: string) => void;
  setOpenMobile: (open: boolean) => void;
}) => {
  const isSharedWithMe = chat.isOwner === false;
  const { visibilityType, setVisibilityType } = useChatVisibility({
    chatId: chat.id,
    initialVisibilityType: chat.visibility,
  });
  const [shareOpen, setShareOpen] = useState(false);

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        className="h-8 rounded-none text-[13px] text-sidebar-foreground/50 transition-all duration-150 hover:bg-transparent hover:text-sidebar-foreground data-active:bg-transparent data-active:font-normal data-active:text-sidebar-foreground/50 data-[active=true]:text-sidebar-foreground data-[active=true]:font-medium data-[active=true]:border-b data-[active=true]:border-dashed data-[active=true]:border-sidebar-foreground/50"
        isActive={isActive}
      >
        <Link href={`/chat/${chat.id}`} onClick={() => setOpenMobile(false)}>
          <span className="truncate">{chat.title}</span>
          {/* A quiet marker that this conversation has other people in it. */}
          {visibilityType === "shared" && (
            <UsersIcon className="ml-auto size-3 shrink-0 opacity-60" />
          )}
          {visibilityType === "public" && (
            <GlobeLucideIcon className="ml-auto size-3 shrink-0 opacity-60" />
          )}
        </Link>
      </SidebarMenuButton>

      <DropdownMenu modal={true}>
        <DropdownMenuTrigger asChild>
          <SidebarMenuAction
            className="mr-0.5 rounded-md text-sidebar-foreground/50 ring-0 transition-colors duration-150 focus-visible:ring-0 hover:text-sidebar-foreground data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            showOnHover={!isActive}
          >
            <MoreHorizontalIcon />
            <span className="sr-only">More</span>
          </SidebarMenuAction>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end" side="bottom">
          {/* One entry, the full dialog: picking WHO to share with needs a people picker,
              which a nested menu can't carry. Only the owner may change access. */}
          {!isSharedWithMe && (
            <DropdownMenuItem
              className="cursor-pointer"
              onSelect={() => setShareOpen(true)}
            >
              <ShareIcon />
              <span>Share</span>
            </DropdownMenuItem>
          )}

          {isSharedWithMe ? (
            <DropdownMenuItem
              onSelect={() => onLeave?.(chat.id)}
              variant="destructive"
            >
              <LogOutIcon className="size-4" />
              <span>Leave chat</span>
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              onSelect={() => onDelete(chat.id)}
              variant="destructive"
            >
              <TrashIcon />
              <span>Delete</span>
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <ShareDialog
        chatId={chat.id}
        onOpenChange={setShareOpen}
        open={shareOpen}
        setVisibilityType={setVisibilityType}
        visibilityType={visibilityType}
      />
    </SidebarMenuItem>
  );
};

export const ChatItem = memo(PureChatItem, (prevProps, nextProps) => {
  if (prevProps.isActive !== nextProps.isActive) {
    return false;
  }
  return true;
});
