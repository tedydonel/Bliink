"use client";

import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { cn } from "@/app/lib/utils";
import { useAppStore } from "@/app/lib/store";
import {
  RadarIcon,
  TransfersIcon,
  MessagesIcon,
  HistoryIcon,
  SettingsIcon,
  ZapIcon,
} from "./Icons";

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const collapsed = useAppStore((s) => s.sidebarCollapsed);
  const scope = useAppStore((s) => s.scope);
  const { devices, transfers, conversations } = useAppStore();

  const isInternet = (d: (typeof devices)[number]) => !!d.nodeId || !!d.manual;
  const scopedDevices = devices.filter((d) =>
    scope === "internet" ? isInternet(d) : !isInternet(d)
  );
  const peerCount = scopedDevices.filter((d) => d.status !== "offline").length;
  const activeCount = transfers.filter(
    (t) =>
      !t.chatMessageId &&
      (t.status === "transferring" || t.status === "pending")
  ).length;
  const unreadCount = conversations.reduce((acc, c) => acc + c.unreadCount, 0);

  const nav = [
    { href: "/", label: "Network", Icon: RadarIcon, badge: peerCount || null, quiet: true },
    { href: "/transfer", label: "Transfers", Icon: TransfersIcon, badge: activeCount || null },
    { href: "/chats", label: "Messages", Icon: MessagesIcon, badge: unreadCount || null },
    { href: "/history", label: "History", Icon: HistoryIcon, badge: null },
  ];

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <nav className={cn("bk-sidebar", collapsed && "collapsed")}>
      {nav.map((n) => (
        <Link
          key={n.href}
          href={n.href}
          className={cn("bk-nav-item", isActive(n.href) && "active")}
        >
          <n.Icon size={17} />
          <span className="bk-nav-label">{n.label}</span>
          {n.badge ? (
            <span className={cn("bk-nav-badge", n.quiet && "quiet")}>
              {n.badge}
            </span>
          ) : null}
        </Link>
      ))}

      <div className="bk-sidebar-spacer" />

      <button
        className="bk-btn bk-quicksend"
        style={{ marginBottom: 8, justifyContent: "flex-start" }}
        onClick={() => router.push("/transfer")}
      >
        <ZapIcon size={14} /> <span className="bk-quicksend-label">Quick send</span>
      </button>

      <Link
        href="/settings"
        className={cn("bk-nav-item", isActive("/settings") && "active")}
      >
        <SettingsIcon size={17} />
        <span className="bk-nav-label">Settings</span>
      </Link>
    </nav>
  );
}
