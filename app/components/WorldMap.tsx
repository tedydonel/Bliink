"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, Minus, RotateCcw } from "lucide-react";
import { feature } from "topojson-client";
import landTopo from "world-atlas/land-110m.json";
import { cn } from "@/app/lib/utils";

// ── projection + dot-field (ported from the prototype) ─────────────

const BK_LAT_TOP = 84;
const BK_LAT_BOT = -58;
const BK_ZMIN = 1;
const BK_ZMAX = 14;
const BK_HOME_VIEW = { lonC: 0, latC: 10, z: 1 };

export interface MapPeer {
  id: string;
  name: string;
  lon: number;
  lat: number;
  status: "transfer" | "connected" | "idle";
  speed?: string;
}
export interface MapHome {
  lon: number;
  lat: number;
  label: string;
}
interface View {
  lonC: number;
  latC: number;
  z: number;
}
interface Ring {
  pts: number[][];
  minLat: number;
  maxLat: number;
}

let LAND_CACHE: Ring[] | null = null;

function prepLand(rings: number[][][]): Ring[] {
  return rings.map((r) => {
    const pts = r.map((p) =>
      Math.abs(p[0]) >= 180 ? [p[0] > 0 ? 179.9999999 : -179.9999999, p[1]] : p
    );
    let mn = 90,
      mx = -90;
    for (const p of pts) {
      if (p[1] < mn) mn = p[1];
      if (p[1] > mx) mx = p[1];
    }
    return { pts, minLat: mn, maxLat: mx };
  });
}

function loadLand(): Ring[] {
  if (LAND_CACHE) return LAND_CACHE;
  const geo: any = feature(landTopo as any, (landTopo as any).objects.land);
  const rings: number[][][] = [];
  const geoms =
    geo.type === "FeatureCollection"
      ? geo.features.map((f: any) => f.geometry)
      : [geo.geometry];
  geoms.forEach((g: any) => {
    const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
    polys.forEach((poly: any) => poly.forEach((ring: any) => rings.push(ring)));
  });
  LAND_CACHE = prepLand(rings);
  return LAND_CACHE;
}

const projK = (view: { z: number }, w: number) => {
  const kx = (w * view.z) / 360;
  return { kx, ky: kx };
};

function clampView(v: View, w: number, h: number): View {
  const z = Math.min(BK_ZMAX, Math.max(BK_ZMIN, v.z));
  const { kx, ky } = projK({ z }, w);
  const halfLon = w / 2 / kx;
  const halfLat = h / 2 / ky;
  const latMid = (BK_LAT_TOP + BK_LAT_BOT) / 2;
  const latHalf = (BK_LAT_TOP - BK_LAT_BOT) / 2;
  return {
    z,
    lonC: halfLon >= 180 ? 0 : Math.min(180 - halfLon, Math.max(-180 + halfLon, v.lonC)),
    latC:
      halfLat >= latHalf
        ? latMid
        : Math.min(BK_LAT_TOP - halfLat, Math.max(BK_LAT_BOT + halfLat, v.latC)),
  };
}

function proj(lon: number, lat: number, view: View, w: number, h: number): [number, number] {
  const { kx, ky } = projK(view, w);
  return [w / 2 + (lon - view.lonC) * kx, h / 2 + (view.latC - lat) * ky];
}

// Scanline-rasterize the world to a fixed degree-space dot field (seam-safe).
function computeDots(land: Ring[], step: number): number[][] {
  const seamLats: number[] = [];
  for (const ring of land) {
    const pts = ring.pts,
      n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = pts[i],
        b = i + 1 < n ? pts[i + 1] : pts[0];
      const d0 = b[0] - a[0];
      const dl = Math.abs(d0) > 180 ? d0 - Math.sign(d0) * 360 : d0;
      const end = a[0] + dl;
      if (a[0] > 0 && end > 180) seamLats.push(a[1] + ((180 - a[0]) / dl) * (b[1] - a[1]));
      else if (a[0] < 0 && end < -180) seamLats.push(a[1] + ((-180 - a[0]) / dl) * (b[1] - a[1]));
    }
  }
  const out: number[][] = [];
  for (let lat = BK_LAT_BOT + step / 2; lat < BK_LAT_TOP; lat += step) {
    const xs: number[] = [];
    let above = 0;
    for (let i = 0; i < seamLats.length; i++) if (seamLats[i] > lat) above++;
    if (above % 2 === 1) xs.push(-180);
    for (const ring of land) {
      if (ring.minLat > lat || ring.maxLat < lat) continue;
      const pts = ring.pts,
        n = pts.length;
      for (let i = 0; i < n; i++) {
        const a = pts[i],
          b = i + 1 < n ? pts[i + 1] : pts[0];
        const ay = a[1],
          by = b[1];
        if (ay > lat === by > lat) continue;
        const ax = a[0];
        let bx = b[0];
        if (Math.abs(bx - ax) > 180) bx = bx > ax ? bx - 360 : bx + 360;
        let xi = ax + ((lat - ay) * (bx - ax)) / (by - ay);
        if (xi < -180) xi += 360;
        else if (xi > 180) xi -= 360;
        xs.push(xi);
      }
    }
    if (!xs.length) continue;
    xs.sort((p, q) => p - q);
    let idx = 0;
    for (let lon = -180 + step / 2; lon < 180; lon += step) {
      while (idx < xs.length && xs[idx] < lon) idx++;
      if (idx % 2 === 1) out.push([lon, lat]);
    }
  }
  return out;
}

const ARC_STYLE: Record<string, { width: number; op: number; dash: string; packet: number; dur: string | null }> = {
  transfer: { width: 1.7, op: 0.75, dash: "3 6", packet: 3, dur: "2.4s" },
  connected: { width: 1.1, op: 0.45, dash: "3 6", packet: 2.2, dur: "4.5s" },
  idle: { width: 1, op: 0.14, dash: "2 8", packet: 0, dur: null },
};

// ── component ──────────────────────────────────────────────────

export default function WorldMap({
  peers,
  home,
  selected,
  onSelect,
  query,
}: {
  peers: MapPeer[];
  home: MapHome | null;
  selected: string | null;
  onSelect: (id: string) => void;
  query: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dim, setDim] = useState({ w: 0, h: 0 });
  const [land] = useState<Ring[]>(() => loadLand());
  const [view, setView] = useState<View>(BK_HOME_VIEW);
  const dimRef = useRef(dim);
  dimRef.current = dim;
  const viewRef = useRef(view);
  viewRef.current = view;
  const dotsRef = useRef<number[][]>([]);
  const drag = useRef<{ x: number; y: number; moved: number } | null>(null);
  const paintedRef = useRef({ w: 0, h: 0 });

  const drawMap = useCallback((w: number, h: number, v: View) => {
    const cv = canvasRef.current;
    const dotsLL = dotsRef.current;
    if (!cv || !w || !h || !dotsLL.length) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const bw = Math.round(Math.max(w, window.innerWidth) * dpr);
    const bh = Math.round(Math.max(h, window.innerHeight) * dpr);
    if (cv.width < bw || cv.height < bh) {
      cv.width = Math.max(cv.width, bw);
      cv.height = Math.max(cv.height, bh);
      cv.style.width = cv.width / dpr + "px";
      cv.style.height = cv.height / dpr + "px";
    }
    const pw = cv.width,
      ph = cv.height;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, pw, ph);
    const { kx } = projK(v, w);
    const sd = Math.max(1, Math.round(Math.min(1.7, 0.66 * kx * 0.55) * dpr));
    const kxd = kx * dpr,
      kyd = kx * dpr;
    const cxd = (w / 2) * dpr,
      cyd = (h / 2) * dpr;
    const lonC = v.lonC,
      latC = v.latC;
    ctx.fillStyle = "rgba(228,240,250,0.27)";
    for (let i = 0; i < dotsLL.length; i++) {
      const x = (cxd + (dotsLL[i][0] - lonC) * kxd) | 0;
      if (x < -2 || x > pw + 2) continue;
      const y = (cyd + (latC - dotsLL[i][1]) * kyd) | 0;
      if (y < -2 || y > ph + 2) continue;
      ctx.fillRect(x, y, sd, sd);
    }
    cv.style.transform = "none";
    paintedRef.current = { w, h };
  }, []);
  const drawRef = useRef(drawMap);
  drawRef.current = drawMap;

  // resize handling (cheap GPU transform during drag, real repaint on settle)
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    let settle: ReturnType<typeof setTimeout>;
    const apply = () => {
      const w = Math.round(el.clientWidth),
        h = Math.round(el.clientHeight);
      const d = dimRef.current;
      if (d.w === w && d.h === h) return;
      const first = !d.w;
      dimRef.current = { w, h };
      if (first) {
        drawRef.current(w, h, viewRef.current);
        setDim({ w, h });
        return;
      }
      const cv = canvasRef.current,
        p = paintedRef.current;
      if (cv && p.w) {
        const s = w / p.w;
        cv.style.transformOrigin = `0px ${p.h / 2}px`;
        cv.style.transform = `scale(${s})`;
      }
      clearTimeout(settle);
      settle = setTimeout(() => setDim((q) => (q.w === w && q.h === h ? q : { w, h })), 90);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    window.addEventListener("resize", apply);
    return () => {
      clearTimeout(settle);
      ro.disconnect();
      window.removeEventListener("resize", apply);
    };
  }, []);

  // wheel zoom toward cursor
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { w, h } = dimRef.current;
      if (!w) return;
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left,
        my = e.clientY - rect.top;
      setView((v) => {
        const factor = Math.exp(-e.deltaY * 0.0016);
        const z2 = Math.min(BK_ZMAX, Math.max(BK_ZMIN, v.z * factor));
        const { kx, ky } = projK(v, w);
        const lonAt = v.lonC + (mx - w / 2) / kx;
        const latAt = v.latC - (my - h / 2) / ky;
        const k2 = projK({ z: z2 }, w);
        return clampView(
          { z: z2, lonC: lonAt - (mx - w / 2) / k2.kx, latC: latAt + (my - h / 2) / k2.ky },
          w,
          h
        );
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return;
    drag.current = { x: e.clientX, y: e.clientY, moved: 0 };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.x,
      dy = e.clientY - drag.current.y;
    drag.current.x = e.clientX;
    drag.current.y = e.clientY;
    drag.current.moved += Math.abs(dx) + Math.abs(dy);
    const { w, h } = dimRef.current;
    if (!w) return;
    setView((v) => {
      const { kx, ky } = projK(v, w);
      return clampView({ z: v.z, lonC: v.lonC - dx / kx, latC: v.latC + dy / ky }, w, h);
    });
  };
  const onPointerUp = () => {
    setTimeout(() => {
      drag.current = null;
    }, 0);
  };
  const onClickCapture = (e: React.MouseEvent) => {
    if (drag.current && drag.current.moved > 5) {
      e.stopPropagation();
      e.preventDefault();
    }
  };

  const zoomBy = (f: number) => {
    const { w, h } = dimRef.current;
    if (!w) return;
    setView((v) => clampView({ ...v, z: v.z * f }, w, h));
  };

  const { w, h } = dim;
  const dotsLL = useMemo(() => (land ? computeDots(land, 0.66) : []), [land]);
  dotsRef.current = dotsLL;

  useEffect(() => {
    drawMap(dimRef.current.w, dimRef.current.h, view);
  }, [w, h, view, dotsLL, drawMap]);

  const [youX, youY] = w && home ? proj(home.lon, home.lat, view, w, h) : [0, 0];
  const q = query.toLowerCase();

  const arcs = peers.map((p) => {
    const [px, py] = proj(p.lon, p.lat, view, w, h);
    const mx = (youX + px) / 2,
      my = (youY + py) / 2;
    const d = Math.hypot(px - youX, py - youY);
    const cy = my - Math.max(24, d * 0.22);
    return {
      p,
      x: px,
      y: py,
      path: `M ${youX} ${youY} Q ${mx} ${cy} ${px} ${py}`,
      style: ARC_STYLE[p.status],
    };
  });

  return (
    <div
      className="bk-map-stage"
      ref={wrapRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onClickCapture={onClickCapture}
      style={{ cursor: drag.current ? "grabbing" : "grab", touchAction: "none" }}
    >
      <canvas ref={canvasRef} className="bk-map-svg" />
      {w > 0 && home ? (
        <svg className="bk-map-svg" viewBox={`0 0 ${w} ${h}`} width={w} height={h}>
          <g fill="none">
            {arcs.map(({ p, path, style }) => (
              <g key={p.id} opacity={q && !p.name.toLowerCase().includes(q) ? 0.15 : 1}>
                <path
                  d={path}
                  stroke="var(--accent)"
                  strokeWidth={style.width}
                  opacity={style.op}
                  strokeDasharray={style.dash}
                  strokeLinecap="round"
                  className={p.status === "idle" ? "" : "bk-arc"}
                />
                {style.packet ? (
                  <circle r={style.packet} fill="var(--accent)" opacity="0.95">
                    <animateMotion dur={style.dur!} repeatCount="indefinite" path={path} />
                  </circle>
                ) : null}
              </g>
            ))}
          </g>
        </svg>
      ) : null}

      {w > 0 && home ? (
        <div className="bk-map-node you" style={{ left: youX, top: youY }}>
          <span className="bk-map-you-core" />
          <span className="bk-map-node-label">{home.label}</span>
        </div>
      ) : null}

      {w > 0
        ? arcs.map(({ p, x, y }) => {
            const dimmed = q && !p.name.toLowerCase().includes(q);
            return (
              <button
                key={p.id}
                className={cn(
                  "bk-map-node",
                  selected === p.id && "selected",
                  p.status === "idle" && "idle"
                )}
                style={{ left: x, top: y, opacity: dimmed ? 0.25 : 1 }}
                onClick={() => onSelect(p.id)}
              >
                <span className="bk-map-dot">
                  {p.status !== "idle" ? <span className="bk-map-ping" /> : null}
                </span>
                <span className="bk-map-node-label">
                  {p.name}
                  {p.status === "transfer" && p.speed ? " ↓ " + p.speed : ""}
                </span>
              </button>
            );
          })
        : null}

      <div className="bk-map-legend">
        <span>
          <i className="lg on" /> connected
        </span>
        <span>
          <i className="lg tx" /> transferring
        </span>
        <span>
          <i className="lg off" /> idle
        </span>
      </div>

      <div className="bk-map-zoom">
        <button className="bk-zoom-btn" title="Zoom in" onClick={() => zoomBy(1.6)}>
          <Plus size={13} />
        </button>
        <button className="bk-zoom-btn" title="Zoom out" onClick={() => zoomBy(1 / 1.6)}>
          <Minus size={13} />
        </button>
        <button
          className="bk-zoom-btn"
          title="Reset view"
          onClick={() => {
            const { w: vw, h: vh } = dimRef.current;
            if (vw) setView(clampView(BK_HOME_VIEW, vw, vh));
          }}
        >
          <RotateCcw size={12} />
        </button>
        <span className="bk-zoom-level">{view.z.toFixed(1)}×</span>
      </div>
    </div>
  );
}
