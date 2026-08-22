import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { extname } from "node:path";
import { Readable } from "node:stream";
import {
  assertPublicResolution,
  parseAllowedRedirectHostname,
  parsePublicHttpsUrl,
} from "./public-network-boundary.mjs";
import {
  inspectStrictHwp5Cfb,
  inspectStrictHwpxZip,
} from "./strict-document-validation.mjs";

export const DEFAULT_DOWNLOAD_LIMITS = Object.freeze({
  maxBytes: 32 * 1024 * 1024,
  maxRedirects: 4,
  timeoutMs: 30_000,
  maxZipEntries: 10_000,
  maxZipUncompressedBytes: 256 * 1024 * 1024,
  maxZipExpansionRatio: 500,
});

function inspectPdf(bytes) {
  const header = bytes.subarray(0, 8).toString("ascii");
  if (!/^%PDF-(?:1\.[0-7]|2\.0)/.test(header)) {
    throw new Error("PDF: canonical header required");
  }
  const tail = bytes.subarray(Math.max(0, bytes.length - 4096)).toString("latin1");
  if (!/%%EOF(?:\s|$)/.test(tail)) throw new Error("PDF: end-of-file marker required");
  return { version: header.slice(5, 8) };
}

function normalizedAllowedHosts(sourceUrl, extraHosts = []) {
  const source = parsePublicHttpsUrl(sourceUrl, "source_url");
  const hosts = new Set([source.hostname]);
  for (const [index, host] of extraHosts.entries()) {
    hosts.add(parseAllowedRedirectHostname(host, `allowed_redirect_hosts[${index}]`));
  }
  return hosts;
}

function requireAllowedUrl(value, allowedHosts, label) {
  const url = parsePublicHttpsUrl(value, label);
  if (!allowedHosts.has(url.hostname)) {
    throw new Error(`${label}: redirect host ${url.hostname} is not allowlisted`);
  }
  return url;
}

/** Inspect the complete HWPX package with bounded in-memory inflation. ZIP64 is rejected. */
export function inspectHwpxZip(bytes, limits = DEFAULT_DOWNLOAD_LIMITS) {
  const policy = { ...DEFAULT_DOWNLOAD_LIMITS, ...limits };
  return inspectStrictHwpxZip(bytes, policy);
}

export const inspectHwp5Cfb = inspectStrictHwp5Cfb;

export function validateDocumentBytes(bytes, file, limits = DEFAULT_DOWNLOAD_LIMITS) {
  const policy = { ...DEFAULT_DOWNLOAD_LIMITS, ...limits };
  if (!Buffer.isBuffer(bytes)) throw new TypeError("document bytes must be a Buffer");
  if (bytes.length === 0 || bytes.length > policy.maxBytes) {
    throw new Error(`document size ${bytes.length} exceeds policy`);
  }
  const extension = extname(file).toLowerCase();
  if (extension === ".hwp") {
    return { format: "hwp5", bytes: bytes.length, cfb: inspectHwp5Cfb(bytes) };
  }
  if (extension === ".hwpx") {
    return { format: "hwpx", bytes: bytes.length, zip: inspectHwpxZip(bytes, policy) };
  }
  if (extension === ".pdf") {
    return { format: "pdf", bytes: bytes.length, pdf: inspectPdf(bytes) };
  }
  throw new Error(`unsupported document extension: ${extension || "(none)"}`);
}

async function rejectResponse(response, message) {
  try {
    await response.body?.cancel();
  } catch {
    // Preserve the primary policy error instead of hiding it behind stream cleanup.
  }
  throw new Error(message);
}

/** HTTPS GET whose TCP lookup is pinned to the already-reviewed DNS answer while TLS keeps hostname SNI. */
export async function pinnedHttpsGet(
  url,
  init,
  addresses,
  { requestImpl = httpsRequest } = {},
) {
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new Error(`source_url: no reviewed address available for ${url.hostname}`);
  }
  return new Promise((resolve, reject) => {
    const attempt = (index) => {
      const address = addresses[index];
      const family = isIP(address);
      let receivedResponse = false;
      const request = requestImpl(
        url,
        {
          method: "GET",
          headers: init.headers,
          signal: init.signal,
          agent: false,
          servername: url.hostname,
          lookup(_hostname, options, callback) {
            if (options?.all) callback(null, [{ address, family }]);
            else callback(null, address, family);
          },
        },
        (incoming) => {
          receivedResponse = true;
          const status = incoming.statusCode;
          if (!status || status < 200 || status > 599) {
            incoming.destroy();
            reject(new Error(`invalid HTTP status ${String(status)}`));
            return;
          }
          const headers = new Headers();
          for (let header = 0; header < incoming.rawHeaders.length; header += 2) {
            headers.append(incoming.rawHeaders[header], incoming.rawHeaders[header + 1]);
          }
          const noBody = status === 204 || status === 205 || status === 304;
          resolve(
            new Response(noBody ? null : Readable.toWeb(incoming), {
              status,
              statusText: incoming.statusMessage,
              headers,
            }),
          );
        },
      );
      request.once("error", (error) => {
        if (receivedResponse) return;
        if (!init.signal?.aborted && index + 1 < addresses.length) attempt(index + 1);
        else reject(error);
      });
      request.end();
    };
    attempt(0);
  });
}

/** Download one bounded document. Every redirect is allowlisted and DNS-checked before fetch. */
export async function downloadDocument(
  item,
  {
    fetchImpl,
    resolver,
    limits = DEFAULT_DOWNLOAD_LIMITS,
    userAgent = "auto-hwp-public-corpus/1 (+https://github.com/kwakseongjae/auto-hwp/issues/100)",
  } = {},
) {
  const policy = { ...DEFAULT_DOWNLOAD_LIMITS, ...limits };
  const allowedHosts = normalizedAllowedHosts(item.source_url, item.allowed_redirect_hosts);
  let current = requireAllowedUrl(item.source_url, allowedHosts, "source_url");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), policy.timeoutMs);
  try {
    for (let redirects = 0; redirects <= policy.maxRedirects; redirects++) {
      const reviewedAddresses = await assertPublicResolution(current, {
        ...(resolver ? { resolver } : {}),
        label: redirects === 0 ? "source_url" : `redirect[${redirects}]`,
        signal: controller.signal,
      });
      const requestInit = {
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": userAgent, "Accept-Encoding": "identity" },
      };
      const response = fetchImpl
        ? await fetchImpl(current, requestInit, { reviewedAddresses })
        : await pinnedHttpsGet(current, requestInit, reviewedAddresses);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) await rejectResponse(response, `HTTP ${response.status} without Location`);
        if (redirects === policy.maxRedirects) {
          await rejectResponse(response, "redirect limit exceeded");
        }
        await response.body?.cancel();
        current = requireAllowedUrl(new URL(location, current).href, allowedHosts, "redirect");
        continue;
      }
      if (!response.ok) await rejectResponse(response, `HTTP ${response.status}`);
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > policy.maxBytes) {
        await rejectResponse(response, `Content-Length ${declared} exceeds policy`);
      }
      if (!response.body) throw new Error("response body is missing");

      const chunks = [];
      let received = 0;
      for await (const chunk of response.body) {
        const part = Buffer.from(chunk);
        received += part.length;
        if (received > policy.maxBytes) throw new Error(`download exceeds ${policy.maxBytes} bytes`);
        chunks.push(part);
      }
      const bytes = Buffer.concat(chunks, received);
      return { bytes, finalUrl: current.href, envelope: validateDocumentBytes(bytes, item.file, policy) };
    }
    throw new Error("redirect loop");
  } finally {
    clearTimeout(timer);
  }
}
