"use client";

import { useAppStore } from "@/app/lib/store";
import { cn } from "@/app/lib/utils";
import TitleBar from "./TitleBar";
import Sidebar from "./Sidebar";
import { PanelLeftIcon } from "./Icons";

/**
 * The window chrome from the design system: grain layer, custom titlebar,
 * sidebar, and the rounded content panel. The scope class drives the
 * teal → blue accent shift across the whole app.
 */
export default function AppShell({ children }: { children: React.ReactNode }) {
  const scope = useAppStore((s) => s.scope);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);

  return (
    <div className={cn("bk-window", scope === "internet" && "scope-internet")}>
      <div className="bk-grain" />
      <TitleBar />
      <div className="bk-main">
        <Sidebar />
        <div className="bk-content">
          {/* sidebar toggle lives here, at the content's top-left */}
          <button
            className="bk-content-toggle"
            title="Toggle sidebar"
            onClick={toggleSidebar}
          >
            <PanelLeftIcon size={16} />
          </button>
          {children}
        </div>
      </div>
    </div>
  );
}
