// SSRF guard for provider base URLs (POST + PUT /api/providers).
// Rikka is a local-first tool: loopback, LAN, and localhost endpoints are
// legitimate targets (local Ollama, LAN gateway, corporate proxy). What is
// never legitimate is the cloud instance-metadata service, which is the one
// exfiltration target reachable from any server. So: non-http(s) schemes,
// unspecified/reserved/multicast addresses, and metadata hosts are rejected;
// everything else passes. Checks are lexical (no DNS) so they stay sync and
// deterministic. The admin API itself is loopback-guarded (adminGuard.ts),
// so only someone who can already reach this machine can register a URL.

const METADATA_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.google.com",
  "instance-data",
  "100.100.100.200", // Alibaba Cloud metadata
]);

const BLOCKED_V4: Array<{ mask: number; net: number }> = [
  { mask: 0xff000000, net: 0x00000000 }, // 0.0.0.0/8 ("this host")
  { mask: 0xffff0000, net: 0xa9fe0000 }, // 169.254.0.0/16 link-local + cloud metadata
  { mask: 0xf0000000, net: 0xe0000000 }, // 224.0.0.0/4 multicast/reserved
  { mask: 0xf0000000, net: 0xf0000000 }, // 240.0.0.0/4 reserved
];

function parseIpv4(host: string): number | null {
  const parts = host.split(".");
  if (parts.length !== 4) {
    // Single-integer form (e.g. http://2130706433/) — normalize before checks.
    if (/^\d+$/.test(host)) {
      const v = Number(host);
      if (Number.isSafeInteger(v) && v >= 0 && v <= 0xffffffff) return v >>> 0;
    }
    return null;
  }
  let n = 0;
  for (const p of parts) {
    let v: number;
    if (/^0x[0-9a-f]+$/i.test(p)) v = parseInt(p, 16); // hex octet (0x7f.0.0.1)
    else if (/^0[0-7]+$/.test(p) && p.length > 1) v = parseInt(p, 8); // octal octet
    else if (!/^\d{1,3}$/.test(p)) return null;
    else v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}
function isBlockedIpv6(host: string): boolean {
  // host arrives without brackets here.
  const h = host.toLowerCase();
  if (h === "::" || h === "0:0:0:0:0:0:0:0") return true; // unspecified
  if (h.startsWith("ff")) return true; // ff00::/8 multicast
  if (h.startsWith("::ffff:")) {
    const v4 = parseIpv4(h.slice("::ffff:".length));
    if (v4 !== null) return isBlockedIpv4Num(v4);
  }
  return false;
}

function isBlockedIpv4Num(n: number): boolean {
  return BLOCKED_V4.some((r) => (n & r.mask) >>> 0 === r.net);
}

/** True for hostnames that must never be used as an upstream base URL. */
export function isBlockedBaseHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.+$/, "");
  if (h === "") return true;
  if (METADATA_HOSTS.has(h)) return true;
  if (h === "0.0.0.0" || h === "[::]" || h === "::") return true;
  if (h.includes(":")) return isBlockedIpv6(h.replace(/^\[|\]$/g, ""));
  const v4 = parseIpv4(h);
  if (v4 !== null) return isBlockedIpv4Num(v4);
  return false;
}

/**
 * Validate a proxy URL (pool add, connection proxyUrl, manual probe).
 * Corporate/LAN forward proxies are legitimate, so unlike base URLs only
 * schemes + unspecified/reserved/multicast/metadata hosts are rejected.
 */
export function ssrfErrorForProxyUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return "proxy URL must be a non-empty string";
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return "proxy URL is not a valid URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `proxy URL scheme must be http or https (got ${url.protocol.slice(0, -1) || "none"})`;
  }
  if (isBlockedBaseHost(url.hostname)) {
    return `proxy URL host "${url.hostname}" is blocked (unspecified/reserved/multicast/metadata hosts are rejected)`;
  }
  return null;
}

/**
 * Validate a provider base URL. Returns a human-readable rejection reason,
 * or null when the URL is an acceptable public http(s) endpoint.
 */
export function ssrfErrorForBaseUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return "base URL must be a non-empty string";
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return "base URL is not a valid URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `base URL scheme must be http or https (got ${url.protocol.slice(0, -1) || "none"})`;
  }
  if (isBlockedBaseHost(url.hostname)) {
    return `base URL host "${url.hostname}" is blocked (unspecified/reserved/multicast/metadata hosts are rejected)`;
  }
  return null;
}
