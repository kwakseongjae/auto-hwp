import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

const PUBLIC_IPV6 = new BlockList();
PUBLIC_IPV6.addSubnet("2000::", 3, "ipv6");

const RESERVED_IPV4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]) {
  RESERVED_IPV4.addSubnet(address, prefix, "ipv4");
}
const RESERVED_IPV6 = new BlockList();
for (const [address, prefix] of [
  ["2001::", 23], // IETF special-purpose space (Teredo/benchmarking/ORCHID/etc.)
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4 can encode a non-public IPv4 destination
  ["3fff::", 20], // documentation
]) {
  RESERVED_IPV6.addSubnet(address, prefix, "ipv6");
}

function fail(label, message) {
  throw new Error(`${label}: ${message}`);
}

/**
 * Return one canonical, public-looking DNS hostname. This is deliberately only the syntactic gate;
 * assertPublicResolution() must also run immediately before each network hop.
 */
export function canonicalPublicHostname(value, label = "hostname") {
  if (typeof value !== "string" || value !== value.trim() || !value) {
    fail(label, "hostname string required");
  }
  const host = value.toLowerCase();
  if (host.endsWith(".")) fail(label, "terminal-dot hostnames are not accepted");
  if (host.length > 253 || !host.includes(".")) fail(label, "public DNS hostname required");
  if (isIP(host) !== 0) fail(label, "IP literals are not accepted");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    fail(label, "local hostname is not accepted");
  }
  const labels = host.split(".");
  if (
    labels.some(
      (part) =>
        part.length < 1 ||
        part.length > 63 ||
        !/^[a-z0-9-]+$/.test(part) ||
        part.startsWith("-") ||
        part.endsWith("-"),
    )
  ) {
    fail(label, "canonical ASCII DNS hostname required");
  }
  return host;
}

/** Parse an HTTPS URL without credentials or a non-default port and canonicalize its hostname. */
export function parsePublicHttpsUrl(value, label = "URL") {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(label, "valid HTTPS URL required");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    fail(label, "HTTPS without credentials required");
  }
  if (url.port) fail(label, "non-default HTTPS ports require a separate reviewed origin");
  const hostname = canonicalPublicHostname(url.hostname, label);
  // URL already performs IDNA and case canonicalization. Reassign to make the returned object explicit.
  url.hostname = hostname;
  return url;
}

/** Validate a manifest redirect-host value without accidentally accepting a URL, port, or path. */
export function parseAllowedRedirectHostname(value, label = "redirect hostname") {
  if (typeof value !== "string" || !/^[A-Za-z0-9.-]+$/.test(value)) {
    fail(label, "hostname string required");
  }
  return canonicalPublicHostname(value, label);
}

export function isPublicIpAddress(address) {
  const family = isIP(address);
  if (family === 4) return !RESERVED_IPV4.check(address, "ipv4");
  if (family === 6) {
    return PUBLIC_IPV6.check(address, "ipv6") && !RESERVED_IPV6.check(address, "ipv6");
  }
  return false;
}

export async function defaultPublicResolver(hostname) {
  return lookup(hostname, { all: true, verbatim: true });
}

/**
 * Resolve and reject the whole hop if any answer is private, reserved, malformed, or empty. A caller
 * may inject a resolver in tests. The production fetch follows immediately after this check.
 */
export async function assertPublicResolution(
  urlOrHostname,
  { resolver = defaultPublicResolver, label = "network hop", signal } = {},
) {
  const hostname =
    urlOrHostname instanceof URL
      ? canonicalPublicHostname(urlOrHostname.hostname, label)
      : canonicalPublicHostname(String(urlOrHostname), label);
  let answers;
  let abortListener;
  try {
    if (signal?.aborted) fail(label, `DNS resolution aborted for ${hostname}`);
    const resolution = Promise.resolve().then(() => resolver(hostname));
    if (signal) {
      const aborted = new Promise((_, reject) => {
        abortListener = () => reject(new Error(`${label}: DNS resolution aborted for ${hostname}`));
        signal.addEventListener("abort", abortListener, { once: true });
      });
      answers = await Promise.race([resolution, aborted]);
    } else {
      answers = await resolution;
    }
  } catch (error) {
    if (String(error?.message ?? error).includes("DNS resolution aborted")) throw error;
    throw new Error(`${label}: DNS resolution failed for ${hostname}: ${error?.message ?? error}`);
  } finally {
    if (abortListener) signal.removeEventListener("abort", abortListener);
  }
  const list = Array.isArray(answers) ? answers : [answers];
  if (list.length === 0) fail(label, `DNS returned no addresses for ${hostname}`);
  for (const answer of list) {
    const address = typeof answer === "string" ? answer : answer?.address;
    if (typeof address !== "string" || !isPublicIpAddress(address)) {
      fail(label, `DNS returned non-public address ${String(address)} for ${hostname}`);
    }
  }
  return list.map((answer) => (typeof answer === "string" ? answer : answer.address));
}
