"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { useCallback, useSyncExternalStore } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Message02Icon,
  GridIcon,
  Settings02Icon,
  Moon02Icon,
  Sun02Icon,
  StructureFolderIcon,
} from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import { usePanel } from "@/hooks/usePanel";

interface BottomNavProps {
  onToggleChatList: () => void;
  skipPermissionsActive?: boolean;
}

const navItems = [
  { href: "/chat", label: "Chats", icon: Message02Icon },
  { href: "/extensions", label: "Extensions", icon: GridIcon },
  { href: "/settings", label: "Settings", icon: Settings02Icon },
] as const;

export function BottomNav({ onToggleChatList, skipPermissionsActive }: BottomNavProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const { panelOpen, setPanelOpen } = usePanel();
  const emptySubscribe = useCallback(() => () => {}, []);
  const mounted = useSyncExternalStore(emptySubscribe, () => true, () => false);
  const isChatRoute = pathname === "/chat" || pathname.startsWith("/chat/");
  const isChatDetailRoute = pathname.startsWith("/chat/");

  return (
    <nav className="fixed inset-x-0 bottom-0 z-50 flex h-14 items-center justify-around border-t border-border bg-sidebar md:hidden">
      {navItems.map((item) => {
        const isActive =
          item.href === "/chat"
            ? isChatRoute
            : item.href === "/extensions"
              ? pathname.startsWith("/extensions")
              : pathname === item.href || pathname.startsWith(item.href + "?");

        const content = (
          <div className="flex flex-col items-center gap-0.5">
            <div className="relative">
              <HugeiconsIcon icon={item.icon} className="h-5 w-5" />
              {item.href === "/settings" && skipPermissionsActive && (
                <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-orange-500" />
              )}
            </div>
            <span className="text-[10px] leading-tight">{item.label}</span>
          </div>
        );

        if (item.href === "/chat") {
          return (
            <button
              key={item.href}
              type="button"
              className={cn(
                "flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-muted-foreground transition-colors",
                isActive && "text-foreground"
              )}
              onClick={() => {
                if (!isChatRoute) {
                  router.push("/chat");
                }
                onToggleChatList();
              }}
            >
              {content}
            </button>
          );
        }

        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-muted-foreground transition-colors",
              isActive && "text-foreground"
            )}
          >
            {content}
          </Link>
        );
      })}

      {/* Files toggle */}
      <button
        type="button"
        className={cn(
          "flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-muted-foreground transition-colors",
          panelOpen && isChatDetailRoute && "text-foreground"
        )}
        onClick={() => {
          if (isChatDetailRoute) {
            setPanelOpen(!panelOpen);
          } else {
            // Pre-set panel open so it shows when user navigates back to a chat
            setPanelOpen(true);
            router.push("/chat");
          }
        }}
      >
        <div className="flex flex-col items-center gap-0.5">
          <HugeiconsIcon icon={StructureFolderIcon} className="h-5 w-5" />
          <span className="text-[10px] leading-tight">Files</span>
        </div>
      </button>

      {/* Theme toggle */}
      {mounted && (
        <button
          type="button"
          className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-muted-foreground transition-colors"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        >
          <div className="flex flex-col items-center gap-0.5">
            <HugeiconsIcon
              icon={theme === "dark" ? Sun02Icon : Moon02Icon}
              className="h-5 w-5"
            />
            <span className="text-[10px] leading-tight">Theme</span>
          </div>
        </button>
      )}
    </nav>
  );
}
