import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_DOWNLOAD_LIMITS,
  downloadDocument,
  inspectHwpxZip,
  pinnedHttpsGet,
  validateDocumentBytes,
} from "../lib/safe-document-download.mjs";
import {
  isPublicIpAddress,
  parsePublicHttpsUrl,
} from "../lib/public-network-boundary.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const hwpx = readFileSync(join(root, "corpus/hwpx/00_smoke_min.hwpx"));
const hwp = readFileSync(join(root, "corpus/hwp/test-image.hwp"));
const xlsx = readFileSync(join(root, "testdata/roster/ok.xlsx"));
const publicResolver = async () => [{ address: "93.184.216.34", family: 4 }];

function firstDeflatedEntry(bytes) {
  let central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  while (central >= 0 && bytes.readUInt32LE(central) === 0x02014b50) {
    const nameLength = bytes.readUInt16LE(central + 28);
    const extraLength = bytes.readUInt16LE(central + 30);
    const commentLength = bytes.readUInt16LE(central + 32);
    if (bytes.readUInt16LE(central + 10) === 8) {
      const local = bytes.readUInt32LE(central + 42);
      const localNameLength = bytes.readUInt16LE(local + 26);
      const localExtraLength = bytes.readUInt16LE(local + 28);
      return {
        central,
        local,
        data: local + 30 + localNameLength + localExtraLength,
        packed: bytes.readUInt32LE(central + 20),
      };
    }
    central += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error("test fixture has no deflated entry");
}

test("network boundary classifies public and reserved IPv4/IPv6 conservatively", () => {
  assert.equal(isPublicIpAddress("93.184.216.34"), true);
  assert.equal(isPublicIpAddress("2606:2800:220:1:248:1893:25c8:1946"), true);
  for (const address of [
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.1.2",
    "172.16.0.1",
    "192.168.0.1",
    "198.51.100.3",
    "203.0.113.4",
    "::1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "::ffff:127.0.0.1",
  ]) {
    assert.equal(isPublicIpAddress(address), false, address);
  }
  assert.throws(() => parsePublicHttpsUrl("https://localhost./x"), /terminal-dot/);
  assert.throws(() => parsePublicHttpsUrl("https://example.test:8443/x"), /non-default/);
});

test("full HWP5 magic and bounded HWPX central directory are accepted", () => {
  const hwpResult = validateDocumentBytes(hwp, "sample.hwp");
  assert.equal(hwpResult.format, "hwp5");
  assert.equal(hwpResult.bytes, hwp.length);
  assert.equal(hwpResult.cfb.fileHeaderBytes, 256);
  const result = validateDocumentBytes(hwpx, "sample.hwpx");
  assert.equal(result.format, "hwpx");
  assert.ok(result.zip.entries > 0);
  assert.ok(result.zip.uncompressedBytes >= result.zip.compressedBytes);
});

test("renamed office ZIPs and fabricated HWP/HWPX envelopes fail semantic container checks", () => {
  assert.throws(() => validateDocumentBytes(xlsx, "renamed.hwpx"), /mimetype/);
  assert.throws(
    () =>
      validateDocumentBytes(
        Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
        "fabricated.hwp",
      ),
    /CFB magic mismatch/,
  );

  const fakeZip = Buffer.alloc(72);
  fakeZip.writeUInt32LE(0x04034b50, 0);
  fakeZip.writeUInt32LE(0x02014b50, 4);
  fakeZip.writeUInt32LE(0x06054b50, 50);
  fakeZip.writeUInt16LE(1, 58);
  fakeZip.writeUInt16LE(1, 60);
  fakeZip.writeUInt32LE(46, 62);
  fakeZip.writeUInt32LE(4, 66);
  assert.throws(() => validateDocumentBytes(fakeZip, "fabricated.hwpx"), /empty entry name/);

  const wrongFileHeader = Buffer.from(hwp);
  const signature = wrongFileHeader.indexOf(Buffer.from("HWP Document File", "ascii"));
  assert.ok(signature >= 0);
  wrongFileHeader[signature] ^= 0xff;
  assert.throws(() => validateDocumentBytes(wrongFileHeader, "wrong-header.hwp"), /signature mismatch/);
});

test("extension/magic swaps and HTML error pages fail before write", () => {
  assert.throws(() => validateDocumentBytes(hwpx, "sample.hwp"), /full CFB magic mismatch/);
  assert.throws(() => validateDocumentBytes(hwp, "sample.hwpx"), /ZIP local-header magic/);
  assert.throws(
    () => validateDocumentBytes(Buffer.from("<!doctype html>error"), "sample.hwpx"),
    /ZIP local-header magic/,
  );
});

test("PDF intake requires a real header and trailing EOF marker", () => {
  const pdf = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\nstartxref\n0\n%%EOF\n");
  assert.deepEqual(validateDocumentBytes(pdf, "reference.pdf").pdf, { version: "1.7" });
  assert.throws(() => validateDocumentBytes(Buffer.from("%PDF-1.7\nno eof"), "bad.pdf"), /end-of-file/);
  assert.throws(() => validateDocumentBytes(Buffer.from("%PDF-9.9\n%%EOF"), "bad.pdf"), /header/);
});

test("ZIP64/bomb-shaped metadata is rejected without extraction", () => {
  const poisoned = Buffer.from(hwpx);
  const central = poisoned.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(central >= 0);
  poisoned.writeUInt32LE(0xffffffff, central + 24);
  assert.throws(() => inspectHwpxZip(poisoned), /ZIP64/);

  assert.throws(
    () =>
      inspectHwpxZip(hwpx, {
        ...DEFAULT_DOWNLOAD_LIMITS,
        maxZipUncompressedBytes: 1,
      }),
    /uncompressed size/,
  );
});

test("HWPX entry paths, encryption and local/central compression structure fail closed", () => {
  const central = hwpx.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(central >= 0);
  const local = hwpx.readUInt32LE(central + 42);

  const unsafePath = Buffer.from(hwpx);
  unsafePath.write("../x.xml", central + 46, "ascii");
  unsafePath.write("../x.xml", local + 30, "ascii");
  assert.throws(() => inspectHwpxZip(unsafePath), /unsafe entry path/);

  const encrypted = Buffer.from(hwpx);
  encrypted.writeUInt16LE(encrypted.readUInt16LE(central + 8) | 1, central + 8);
  encrypted.writeUInt16LE(encrypted.readUInt16LE(local + 6) | 1, local + 6);
  assert.throws(() => inspectHwpxZip(encrypted), /encrypted entry/);

  const mismatched = Buffer.from(hwpx);
  mismatched.writeUInt16LE(8, local + 8);
  assert.throws(() => inspectHwpxZip(mismatched), /local\/central header mismatch/);

  const unsupported = Buffer.from(hwpx);
  unsupported.writeUInt16LE(99, central + 10);
  unsupported.writeUInt16LE(99, local + 8);
  assert.throws(() => inspectHwpxZip(unsupported), /unsupported flags\/compression/);
});

test("HWPX validates actual inflate size and CRC instead of trusting declared ZIP metadata", () => {
  const { central, local, data, packed } = firstDeflatedEntry(hwpx);
  const missingDescriptor = Buffer.from(hwpx);
  missingDescriptor.writeUInt16LE(missingDescriptor.readUInt16LE(central + 8) | 8, central + 8);
  missingDescriptor.writeUInt16LE(missingDescriptor.readUInt16LE(local + 6) | 8, local + 6);
  missingDescriptor.writeUInt32LE(0, local + 14);
  missingDescriptor.writeUInt32LE(0, local + 18);
  missingDescriptor.writeUInt32LE(0, local + 22);
  assert.throws(() => inspectHwpxZip(missingDescriptor), /unsupported flags\/compression/);

  const liedAboutSize = Buffer.from(hwpx);
  liedAboutSize.writeUInt32LE(1, central + 24);
  liedAboutSize.writeUInt32LE(1, local + 22);
  assert.throws(() => inspectHwpxZip(liedAboutSize), /invalid\/bounded deflate|inflated size/);

  const corruptPayload = Buffer.from(hwpx);
  corruptPayload[data + Math.floor(packed / 2)] ^= 0x40;
  assert.throws(() => inspectHwpxZip(corruptPayload), /invalid\/bounded deflate|CRC-32 mismatch/);
});

test("downloadDocument enforces host allowlist and byte cap across redirects", async () => {
  const item = {
    file: "sample.hwpx",
    source_url: "https://files.example.test/sample.hwpx",
    allowed_redirect_hosts: ["cdn.example.test"],
  };
  const calls = [];
  const reviewed = [];
  const goodFetch = async (url, _init, context) => {
    calls.push(String(url));
    reviewed.push(context.reviewedAddresses);
    if (String(url).includes("files.example.test")) {
      return new Response(null, {
        status: 302,
        headers: { location: "https://cdn.example.test/final.hwpx" },
      });
    }
    return new Response(hwpx, { status: 200, headers: { "content-length": String(hwpx.length) } });
  };
  const result = await downloadDocument(item, {
    fetchImpl: goodFetch,
    resolver: publicResolver,
    userAgent: "test",
  });
  assert.equal(result.finalUrl, "https://cdn.example.test/final.hwpx");
  assert.equal(result.envelope.format, "hwpx");
  assert.equal(calls.length, 2);
  assert.deepEqual(reviewed, [["93.184.216.34"], ["93.184.216.34"]]);

  const evilFetch = async () =>
    new Response(null, { status: 302, headers: { location: "https://evil.example/final.hwpx" } });
  await assert.rejects(
    downloadDocument(item, { fetchImpl: evilFetch, resolver: publicResolver, userAgent: "test" }),
    /redirect host evil\.example is not allowlisted/,
  );

  const oversized = {
    ...DEFAULT_DOWNLOAD_LIMITS,
    maxBytes: hwpx.length - 1,
  };
  await assert.rejects(
    downloadDocument(item, {
      fetchImpl: async () =>
        new Response(hwpx, { status: 200, headers: { "content-length": String(hwpx.length) } }),
      resolver: publicResolver,
      limits: oversized,
      userAgent: "test",
    }),
    /Content-Length .* exceeds policy/,
  );
});

test("default HTTPS transport pins lookup to the reviewed address while preserving TLS hostname", async () => {
  let requestUrl;
  let requestOptions;
  const lookupResults = [];
  const requestImpl = (url, options, callback) => {
    requestUrl = url;
    requestOptions = options;
    options.lookup("ignored.example", { all: false }, (...args) => lookupResults.push(args));
    options.lookup("ignored.example", { all: true }, (...args) => lookupResults.push(args));
    const request = new EventEmitter();
    request.end = () => {
      const incoming = Readable.from([hwpx]);
      incoming.statusCode = 200;
      incoming.statusMessage = "OK";
      incoming.rawHeaders = ["Content-Length", String(hwpx.length)];
      callback(incoming);
    };
    return request;
  };
  const response = await pinnedHttpsGet(
    new URL("https://files.example.test/sample.hwpx"),
    { headers: { "User-Agent": "test" } },
    ["93.184.216.34"],
    { requestImpl },
  );
  assert.equal(String(requestUrl), "https://files.example.test/sample.hwpx");
  assert.equal(requestOptions.servername, "files.example.test");
  assert.equal(requestOptions.agent, false);
  assert.deepEqual(lookupResults, [
    [null, "93.184.216.34", 4],
    [null, [{ address: "93.184.216.34", family: 4 }]],
  ]);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), hwpx);
});

test("downloadDocument rejects terminal-dot and private DNS answers before the affected fetch", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response(hwpx, { status: 200 });
  };
  await assert.rejects(
    downloadDocument(
      { file: "sample.hwpx", source_url: "https://localhost./sample.hwpx" },
      { fetchImpl, resolver: publicResolver, userAgent: "test" },
    ),
    /terminal-dot/,
  );
  assert.equal(calls, 0);

  await assert.rejects(
    downloadDocument(
      { file: "sample.hwpx", source_url: "https://files.example.test/sample.hwpx" },
      { fetchImpl, resolver: async () => [{ address: "127.0.0.1", family: 4 }], userAgent: "test" },
    ),
    /non-public address 127\.0\.0\.1/,
  );
  assert.equal(calls, 0);

  const redirecting = async () => {
    calls++;
    return new Response(null, {
      status: 302,
      headers: { location: "https://cdn.example.test/final.hwpx" },
    });
  };
  await assert.rejects(
    downloadDocument(
      {
        file: "sample.hwpx",
        source_url: "https://files.example.test/sample.hwpx",
        allowed_redirect_hosts: ["cdn.example.test"],
      },
      {
        fetchImpl: redirecting,
        resolver: async (host) => [
          { address: host === "cdn.example.test" ? "10.0.0.4" : "93.184.216.34", family: 4 },
        ],
        userAgent: "test",
      },
    ),
    /non-public address 10\.0\.0\.4/,
  );
  assert.equal(calls, 1, "redirect target DNS must fail before a second fetch");
});

test("the total download timeout also bounds DNS resolution", async () => {
  await assert.rejects(
    downloadDocument(
      { file: "sample.hwpx", source_url: "https://files.example.test/sample.hwpx" },
      {
        fetchImpl: async () => new Response(hwpx),
        resolver: async () => new Promise(() => {}),
        limits: { ...DEFAULT_DOWNLOAD_LIMITS, timeoutMs: 20 },
        userAgent: "test",
      },
    ),
    /DNS resolution aborted/,
  );
});
