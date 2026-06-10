"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { useState } from "react";
import {
  Monitor,
  ArrowLeftRight,
  MessageCircle,
  Clock,
  User,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { cn } from "@/app/lib/utils";
import { useAppStore } from "@/app/lib/store";

const navItems = [
  { href: "/", label: "Devices", icon: Monitor },
  { href: "/transfer", label: "Transfer", icon: ArrowLeftRight },
  { href: "/chats", label: "Chats", icon: MessageCircle },
  { href: "/history", label: "History", icon: Clock },
];

export default function Sidebar() {
  const pathname = usePathname();
  const [isCollapsed, setIsCollapsed] = useState(false);
  const { transfers, conversations, settings } = useAppStore();

  const activeCount = transfers.filter(
    (t) =>
      !t.chatMessageId &&
      (t.status === "transferring" || t.status === "pending")
  ).length;
  const unreadCount = conversations.reduce((acc, c) => acc + c.unreadCount, 0);

  return (
    <aside 
      className={cn(
        "flex flex-col shrink-0 bg-sidebar border-r border-border h-full transition-all duration-300 ease-in-out relative group",
        isCollapsed ? "w-[60px]" : "w-[220px]"
      )}
    >
      {/* Collapse Toggle */}
      <button
        onClick={() => setIsCollapsed(!isCollapsed)}
        className="absolute -right-3 top-6 bg-surface border border-border rounded-full p-1 text-muted hover:text-foreground hover:border-accent transition-colors z-50 shadow-sm"
      >
        {isCollapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
      </button>

      {/* Navigation */}
      <nav className="flex flex-col gap-1 px-2 mt-6 flex-1">
        {navItems.map((item) => {
          const isActive =
            item.href === "/"
              ? pathname === "/"
              : pathname.startsWith(item.href);
          const badgeCount =
            item.href === "/transfer"
              ? activeCount
              : item.href === "/chats"
              ? unreadCount
              : 0;
          const showBadge = badgeCount > 0;
          
          return (
            <div key={item.href} className="relative group/tooltip">
              <Link
                href={item.href}
                className={cn(
                  "flex items-center gap-3 px-3 py-2.5 rounded-lg text-[13px] font-medium transition-all duration-150 relative overflow-hidden",
                  isActive
                    ? "bg-accent/10 text-accent border border-accent/15"
                    : "text-muted-light hover:text-foreground hover:bg-sidebar-hover border border-transparent",
                  isCollapsed ? "justify-center px-0" : ""
                )}
              >
                <item.icon
                  className={cn(
                    "w-[18px] h-[18px] shrink-0",
                    isActive ? "text-accent" : "text-muted"
                  )}
                />
                {!isCollapsed && (
                  <>
                    <span className="truncate">{item.label}</span>
                    {showBadge && (
                      <span className="ml-auto flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-sky/20 text-sky text-[10px] font-bold">
                        {badgeCount}
                      </span>
                    )}
                  </>
                )}
                
                {isCollapsed && showBadge && (
                  <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-sky border border-sidebar" />
                )}
                
                {isActive && (
                  <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-4 rounded-r-full bg-accent" />
                )}
              </Link>
              
              {/* Tooltip for collapsed state */}
              {isCollapsed && (
                <div className="absolute left-full top-1/2 -translate-y-1/2 ml-2 px-2 py-1 bg-surface border border-border rounded text-[11px] text-foreground whitespace-nowrap opacity-0 group-hover/tooltip:opacity-100 pointer-events-none transition-opacity z-50">
                  {item.label}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      {/* Profile / Settings at Bottom */}
      <div className="p-2 mt-auto border-t border-border">
        <Link
          href="/settings"
          className={cn(
            "flex items-center gap-3 p-2 rounded-xl transition-all hover:bg-surface-hover group/profile relative",
            pathname.startsWith("/settings") ? "bg-surface-active" : "",
            isCollapsed ? "justify-center" : ""
          )}
        >
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-accent/20 to-sky/20 border border-accent/20 flex items-center justify-center shrink-0">
             <User className="w-4 h-4 text-accent" />
          </div>
          
          {!isCollapsed && (
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-semibold text-foreground truncate">
                {settings.deviceName || "My Device"}
              </div>
              <div className="text-[11px] text-muted truncate">
                Settings
              </div>
            </div>
          )}
          
          {isCollapsed && (
            <div className="absolute left-full top-1/2 -translate-y-1/2 ml-2 px-2 py-1 bg-surface border border-border rounded text-[11px] text-foreground whitespace-nowrap opacity-0 group-hover/profile:opacity-100 pointer-events-none transition-opacity z-50">
              Profile & Settings
            </div>
          )}
        </Link>
      </div>
    </aside>
  );
}
