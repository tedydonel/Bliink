"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Web Access now lives inside Settings. Keep this route as a redirect so old
// links / bookmarks don't 404.
export default function WebAccessRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/settings");
  }, [router]);
  return null;
}
