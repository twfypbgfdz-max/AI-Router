// Shared loopback-only validator for any Ollama base URL used by this
// router - both the text-response provider config and the /api/tags
// availability check must agree on exactly the same allowed shape, so this
// lives in one place rather than two independently maintained regexes.
//
// Allowed: http://127.0.0.1[:port], http://localhost[:port], http://[::1][:port].
// Rejected: any other hostname (external, private-LAN, public IP), any
// credentials, query string, fragment, non-root path, or protocol other
// than plain http (loopback traffic never needs TLS and https here would
// only hide a misconfiguration).
const LOOPBACK_HOSTNAMES = Object.freeze(new Set(["127.0.0.1", "localhost", "[::1]"]));

export function parseOllamaLoopbackUrl(raw) {
  if (typeof raw !== "string" || !raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  if (url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  if (!LOOPBACK_HOSTNAMES.has(url.hostname.toLowerCase())) return null;
  return url.origin;
}

export const ollamaLoopbackInternals = Object.freeze({ LOOPBACK_HOSTNAMES });
