"use client";

import { useEffect, useState } from "react";
import { getThumbnail } from "@/app/lib/tauri-api";

/**
 * Thumbnail for a local file path, falling back to the given icon when the
 * file type has no preview. Results are cached in the API layer.
 */
export default function FileThumb({
  path,
  className,
  fallback,
}: {
  path?: string;
  className?: string;
  fallback: React.ReactNode;
}) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    if (path) {
      getThumbnail(path).then((url) => {
        if (mounted) setSrc(url);
      });
    } else {
      setSrc(null);
    }
    return () => {
      mounted = false;
    };
  }, [path]);

  if (!src) return <>{fallback}</>;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="" className={className} />;
}
