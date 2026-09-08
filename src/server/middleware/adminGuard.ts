// Admin-surface guard: /api/* stays open on loopback (local dashboard/CLI),
// but when the process is reached through a non-loopback Host and no
// RIKKA_API_KEY is configured, the request is rejected instead of silently
// exposing key management to the network. Deliberately NOT a full auth gate
// (that would lock out local users) — just a trip-wire for accidental
// exposure, plus a loud boot warning when bound to 0.0.0.0.

function hostnameOf(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end === -1 ? h : h.slice(1, end);
  }
  const colon = h.lastIndexOf(":");
  // A single colon means host:port; multiple colons mean a bare IPv6 literal.
  if (colon !== -1 && h.indexOf(":") === colon) return h.slice(0, colon);
  return h;
}

/** True for loopback Host values (or a missing Host, i.e. in-process calls). */
export function isLoopbackHost(hostHeader: string | null | undefined): boolean {
  if (hostHeader === null || hostHeader === undefined || hostHeader.trim() === "") return true;
  const h = hostnameOf(hostHeader).replace(/\.+$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::1" || h === "::ffff:127.0.0.1") return true;
  if (h.includes(":")) return false; // other IPv6 literals are not loopback
  const parts = h.split(".");
  if (parts.length === 4 && parts[0] === "127" && parts.every((p) => /^\d{1,3}$/.test(p))) return true;
  return false;
}

export function isWildcardBind(host: string | null | undefined): boolean {
  if (!host) return false;
  const h = host.trim();
  return h === "0.0.0.0" || h === "::" || h === "[::]";
}

let warned = false;

/** Loud one-time warning when the server listens on all interfaces. */
export function warnIfWildcardBind(host: string | null | undefined): void {
  if (!isWildcardBind(host) || warned) return;
  warned = true;
  console.warn(
    "rikka SECURITY: HOST=0.0.0.0 — admin API (/api/*) is reachable from the network. " +
      "Bind HOST=127.0.0.1 or front the port with an authenticating proxy. " +
      "Requests via a non-loopback Host are rejected while RIKKA_API_KEY is unset.",
  );
}

/** Hono middleware: reject non-loopback /api/* traffic while no API key is set. */
export async function adminGuard(
  c: { req: { header: (name: string) => string | undefined }; json: (body: unknown, status?: number) => Response; env?: unknown },
  next: () => Promise<void>,
): Promise<Response | void> {
  if (process.env.RIKKA_API_KEY) {
    await next();
    return;
  }
  // The Host header is client-controlled: a remote caller can send
  // `Host: localhost` to pass a header-only check. The socket address can't
  // be forged, so it decides when present; the header is only a fallback for
  // in-process calls (tests) where no socket exists.
  const remote = remoteAddress(c);
  if (remote !== null) {
    if (!isLoopbackIp(remote)) {
      return c.json(
        {
          error: {
            message: "admin API is not exposed on non-loopback interfaces while RIKKA_API_KEY is unset — bind HOST=127.0.0.1 or set RIKKA_API_KEY",
            type: "forbidden",
          },
        },
        403,
      );
    }
    await next();
    return;
  }
  if (isLoopbackHost(c.req.header("host"))) {
    await next();
    return;
  }
  return c.json(
    {
      error: {
        message: "admin API is not exposed on non-loopback interfaces while RIKKA_API_KEY is unset — bind HOST=127.0.0.1 or set RIKKA_API_KEY",
        type: "forbidden",
      },
    },
    403,
  );
}

function remoteAddress(c: { env?: unknown; req: Record<string, unknown> }): string | null {
  try {
    const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
    const ra = env?.incoming?.socket?.remoteAddress;
    if (typeof ra === "string" && ra) return ra;
  } catch {}
  try {
    const raw = c.req.raw as { socket?: { remoteAddress?: string } } | undefined;
    const ra = raw?.socket?.remoteAddress;
    if (typeof ra === "string" && ra) return ra;
  } catch {}
  return null;
}

function isLoopbackIp(ip: string): boolean {
  const h = ip.trim().toLowerCase().replace(/^::ffff:/, "");
  if (h === "::1") return true;
  const parts = h.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every((p) => /^\d{1,3}$/.test(p));
}
