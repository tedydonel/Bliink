// Best-effort GeoIP for the Internet world map. Resolves this device's own
// public location and any peer's public IP to lat/lon via a free HTTPS API
// (no key). Results are cached for the session. Private/LAN addresses and
// failures resolve to null — those peers simply aren't plotted on the map.

export interface Geo {
  lat: number;
  lon: number;
  city?: string;
  country?: string;
}

const ipCache = new Map<string, Geo | null>();
let selfGeo: Geo | null | undefined;

async function lookup(url: string): Promise<Geo | null> {
  try {
    const res = await fetch(url);
    const j: any = await res.json();
    if (j && j.success !== false && typeof j.latitude === "number") {
      return { lat: j.latitude, lon: j.longitude, city: j.city, country: j.country };
    }
  } catch {
    /* offline or rate-limited — leave unplotted */
  }
  return null;
}

const isPublicIpv4 = (ip: string) =>
  /^\d+\.\d+\.\d+\.\d+$/.test(ip) &&
  !/^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);

/** This device's own approximate location (from its public IP). */
export async function geoSelf(): Promise<Geo | null> {
  if (selfGeo !== undefined) return selfGeo;
  selfGeo = await lookup("https://ipwho.is/");
  return selfGeo;
}

/** Approximate location for a peer's public IP, or null if not locatable. */
export async function geoForIp(ip: string | undefined | null): Promise<Geo | null> {
  if (!ip || !isPublicIpv4(ip)) return null;
  if (ipCache.has(ip)) return ipCache.get(ip)!;
  const g = await lookup(`https://ipwho.is/${ip}`);
  ipCache.set(ip, g);
  return g;
}
