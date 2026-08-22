import { TextDecoder } from "node:util";
import { inflateRawSync } from "node:zlib";

const HWP_CFB_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const HWP_FILE_HEADER_SIGNATURE = Buffer.from("HWP Document File", "ascii");
const HWPX_MIMETYPE = Buffer.from("application/hwp+zip", "ascii");
const ZIP_LOCAL_MAGIC = 0x04034b50;
const ZIP_CENTRAL_MAGIC = 0x02014b50;
const ZIP_EOCD_MAGIC = 0x06054b50;
const ZIP64_EXTRA_ID = 0x0001;
const ZIP_ALLOWED_FLAGS = 0x0806; // deflate options and UTF-8 names; data descriptors are rejected
const ZIP_ENCRYPTION_FLAGS = 0x2041;

const CFB_FREE = 0xffffffff;
const CFB_END = 0xfffffffe;
const CFB_FAT = 0xfffffffd;
const CFB_DIFAT = 0xfffffffc;
const CFB_MAX_REGULAR = 0xfffffffa;

const CRC32_TABLE = new Uint32Array(256);
for (let value = 0; value < 256; value++) {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  CRC32_TABLE[value] = crc >>> 0;
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function checkedRead(bytes, offset, length, label) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + length > bytes.length) {
    throw new Error(`${label}: truncated structure`);
  }
}

function findStrictEocd(bytes) {
  const floor = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= floor; offset--) {
    if (bytes.readUInt32LE(offset) !== ZIP_EOCD_MAGIC) continue;
    const commentLength = bytes.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === bytes.length) return offset;
  }
  throw new Error("HWPX ZIP: canonical end-of-central-directory not found");
}

function inspectZipExtra(extra, label) {
  let offset = 0;
  while (offset < extra.length) {
    if (offset + 4 > extra.length) throw new Error(`${label}: malformed ZIP extra field`);
    const id = extra.readUInt16LE(offset);
    const size = extra.readUInt16LE(offset + 2);
    offset += 4;
    if (offset + size > extra.length) throw new Error(`${label}: malformed ZIP extra field`);
    if (id === ZIP64_EXTRA_ID) throw new Error(`${label}: ZIP64 is not accepted by the corpus intake`);
    offset += size;
  }
}

function decodeZipName(raw, flags, index) {
  if (raw.length === 0) throw new Error(`HWPX ZIP: empty entry name at ${index}`);
  let name;
  if ((flags & 0x0800) !== 0) {
    try {
      name = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      throw new Error(`HWPX ZIP: invalid UTF-8 entry name at ${index}`);
    }
  } else {
    if (raw.some((byte) => byte > 0x7f)) {
      throw new Error(`HWPX ZIP: non-ASCII entry name lacks the UTF-8 flag at ${index}`);
    }
    name = raw.toString("ascii");
  }
  if (name !== name.normalize("NFC")) throw new Error(`HWPX ZIP: non-NFC entry name ${name}`);
  if (name.includes("\0") || name.includes("\\") || name.startsWith("/") || /^[a-z]:/i.test(name)) {
    throw new Error(`HWPX ZIP: unsafe entry path ${name}`);
  }
  const directory = name.endsWith("/");
  const parts = name.split("/");
  if (directory) parts.pop();
  if (parts.length === 0 || parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`HWPX ZIP: unsafe entry path ${name}`);
  }
  return { name, directory };
}

/** Inspect a strict HWPX/OWPML ZIP without extracting untrusted content. */
export function inspectStrictHwpxZip(bytes, policy) {
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== ZIP_LOCAL_MAGIC) {
    throw new Error("HWPX: ZIP local-header magic required");
  }
  const eocd = findStrictEocd(bytes);
  const disk = bytes.readUInt16LE(eocd + 4);
  const centralDisk = bytes.readUInt16LE(eocd + 6);
  const entriesOnDisk = bytes.readUInt16LE(eocd + 8);
  const entries = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== entries ||
    entries === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw new Error("HWPX ZIP: multi-disk/ZIP64 is not accepted by the corpus intake");
  }
  if (entries < 1 || entries > policy.maxZipEntries) {
    throw new Error(`HWPX ZIP: entry count ${entries} exceeds policy`);
  }
  if (centralOffset + centralSize !== eocd || centralOffset >= bytes.length) {
    throw new Error("HWPX ZIP: central directory bounds are invalid");
  }

  const names = new Map();
  const caseFoldedNames = new Set();
  const spans = [];
  let offset = centralOffset;
  let compressed = 0;
  let uncompressed = 0;
  for (let index = 0; index < entries; index++) {
    if (offset + 46 > eocd || bytes.readUInt32LE(offset) !== ZIP_CENTRAL_MAGIC) {
      throw new Error(`HWPX ZIP: invalid central entry ${index}`);
    }
    const madeBy = bytes.readUInt16LE(offset + 4);
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const crc = bytes.readUInt32LE(offset + 16);
    const packed = bytes.readUInt32LE(offset + 20);
    const unpacked = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const startDisk = bytes.readUInt16LE(offset + 34);
    const externalAttributes = bytes.readUInt32LE(offset + 38);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const centralEnd = offset + 46 + nameLength + extraLength + commentLength;
    if (centralEnd > centralOffset + centralSize) {
      throw new Error(`HWPX ZIP: truncated central entry ${index}`);
    }
    if (
      packed === 0xffffffff ||
      unpacked === 0xffffffff ||
      localOffset === 0xffffffff ||
      startDisk !== 0
    ) {
      throw new Error("HWPX ZIP: ZIP64/multi-disk entry is not accepted by the corpus intake");
    }
    if ((flags & ZIP_ENCRYPTION_FLAGS) !== 0) {
      throw new Error(`HWPX ZIP: encrypted entry is not accepted at ${index}`);
    }
    if ((flags & ~ZIP_ALLOWED_FLAGS) !== 0 || (method !== 0 && method !== 8)) {
      throw new Error(`HWPX ZIP: unsupported flags/compression at entry ${index}`);
    }
    const rawName = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const { name, directory } = decodeZipName(rawName, flags, index);
    const nameKey = name.toLowerCase();
    if (caseFoldedNames.has(nameKey)) throw new Error(`HWPX ZIP: duplicate entry path ${name}`);
    caseFoldedNames.add(nameKey);
    const centralExtra = bytes.subarray(
      offset + 46 + nameLength,
      offset + 46 + nameLength + extraLength,
    );
    inspectZipExtra(centralExtra, `HWPX ZIP entry ${name}`);
    const unixMode = madeBy >> 8 === 3 ? externalAttributes >>> 16 : 0;
    if ((unixMode & 0o170000) === 0o120000) {
      throw new Error(`HWPX ZIP: symbolic-link entry is not accepted: ${name}`);
    }

    checkedRead(bytes, localOffset, 30, `HWPX ZIP local entry ${name}`);
    if (bytes.readUInt32LE(localOffset) !== ZIP_LOCAL_MAGIC) {
      throw new Error(`HWPX ZIP: local header missing for ${name}`);
    }
    const localFlags = bytes.readUInt16LE(localOffset + 6);
    const localMethod = bytes.readUInt16LE(localOffset + 8);
    const localCrc = bytes.readUInt32LE(localOffset + 14);
    const localPacked = bytes.readUInt32LE(localOffset + 18);
    const localUnpacked = bytes.readUInt32LE(localOffset + 22);
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    checkedRead(
      bytes,
      localOffset + 30,
      localNameLength + localExtraLength,
      `HWPX ZIP local entry ${name}`,
    );
    const localName = bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength);
    if (localFlags !== flags || localMethod !== method || !localName.equals(rawName)) {
      throw new Error(`HWPX ZIP: local/central header mismatch for ${name}`);
    }
    const localExtra = bytes.subarray(
      localOffset + 30 + localNameLength,
      localOffset + 30 + localNameLength + localExtraLength,
    );
    inspectZipExtra(localExtra, `HWPX ZIP local entry ${name}`);
    if (localCrc !== crc || localPacked !== packed || localUnpacked !== unpacked) {
      throw new Error(`HWPX ZIP: local/central sizes mismatch for ${name}`);
    }
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataOffset + packed;
    if (dataEnd > centralOffset) throw new Error(`HWPX ZIP: data bounds are invalid for ${name}`);
    spans.push({ start: localOffset, end: dataEnd, name });

    compressed += packed;
    uncompressed += unpacked;
    if (uncompressed > policy.maxZipUncompressedBytes) {
      throw new Error(`HWPX ZIP: uncompressed size ${uncompressed} exceeds policy`);
    }
    const entryRatio = unpacked / Math.max(1, packed);
    if (entryRatio > policy.maxZipExpansionRatio) {
      throw new Error(`HWPX ZIP: entry expansion ratio exceeds policy for ${name}`);
    }
    const compressedPayload = bytes.subarray(dataOffset, dataEnd);
    let payload;
    if (method === 0) {
      if (packed !== unpacked) throw new Error(`HWPX ZIP: stored entry size mismatch for ${name}`);
      payload = compressedPayload;
    } else {
      try {
        const inflated = inflateRawSync(compressedPayload, {
          info: true,
          maxOutputLength: Math.max(1, unpacked),
        });
        if (inflated.engine.bytesWritten !== packed) {
          throw new Error("deflate stream has trailing or unconsumed input");
        }
        payload = inflated.buffer;
      } catch (error) {
        throw new Error(`HWPX ZIP: invalid/bounded deflate payload for ${name}: ${error?.message ?? error}`);
      }
      if (payload.length !== unpacked) {
        throw new Error(`HWPX ZIP: inflated size mismatch for ${name}`);
      }
    }
    if (crc32(payload) !== crc) throw new Error(`HWPX ZIP: CRC-32 mismatch for ${name}`);
    names.set(name, { name, directory, method, packed, unpacked, dataOffset, localOffset });
    offset = centralEnd;
  }
  if (offset !== centralOffset + centralSize) {
    throw new Error("HWPX ZIP: central directory length mismatch");
  }
  spans.sort((a, b) => a.start - b.start);
  for (let index = 1; index < spans.length; index++) {
    if (spans[index - 1].end > spans[index].start) {
      throw new Error(
        `HWPX ZIP: overlapping local entries ${spans[index - 1].name} and ${spans[index].name}`,
      );
    }
  }
  if (uncompressed > policy.maxZipUncompressedBytes) {
    throw new Error(`HWPX ZIP: uncompressed size ${uncompressed} exceeds policy`);
  }
  const ratio = uncompressed / Math.max(1, compressed);
  if (ratio > policy.maxZipExpansionRatio) {
    throw new Error(`HWPX ZIP: expansion ratio ${ratio.toFixed(1)} exceeds policy`);
  }

  const mimetype = names.get("mimetype");
  if (!mimetype || mimetype.directory || mimetype.method !== 0 || mimetype.localOffset !== 0) {
    throw new Error("HWPX: first uncompressed mimetype entry is required");
  }
  const mimetypeBytes = bytes.subarray(mimetype.dataOffset, mimetype.dataOffset + mimetype.packed);
  if (!mimetypeBytes.equals(HWPX_MIMETYPE)) {
    throw new Error("HWPX: mimetype must be application/hwp+zip");
  }
  for (const required of [
    "version.xml",
    "META-INF/container.xml",
    "Contents/content.hpf",
    "Contents/header.xml",
  ]) {
    if (!names.has(required) || names.get(required).directory) {
      throw new Error(`HWPX: required OWPML entry missing: ${required}`);
    }
  }
  if (![...names.keys()].some((name) => /^Contents\/section\d+\.xml$/.test(name))) {
    throw new Error("HWPX: at least one Contents/sectionN.xml entry is required");
  }
  return {
    entries,
    compressedBytes: compressed,
    uncompressedBytes: uncompressed,
    expansionRatio: ratio,
  };
}

function cfbSectorReader(bytes, sectorSize) {
  if (bytes.length < sectorSize || bytes.length % sectorSize !== 0) {
    throw new Error("HWP5 CFB: file length is not sector-aligned");
  }
  const sectorCount = bytes.length / sectorSize - 1;
  const readSector = (sectorId, label) => {
    if (!Number.isInteger(sectorId) || sectorId < 0 || sectorId >= sectorCount) {
      throw new Error(`${label}: invalid sector ${sectorId}`);
    }
    const offset = (sectorId + 1) * sectorSize;
    return bytes.subarray(offset, offset + sectorSize);
  };
  return { sectorCount, readSector };
}

function regularCfbSector(value) {
  return Number.isInteger(value) && value >= 0 && value <= CFB_MAX_REGULAR;
}

function walkCfbChain(start, table, maximum, label) {
  if (start === CFB_END) return [];
  if (!regularCfbSector(start)) throw new Error(`${label}: invalid chain start`);
  const seen = new Set();
  const result = [];
  let current = start;
  while (current !== CFB_END) {
    if (!regularCfbSector(current) || current >= table.length || current >= maximum) {
      throw new Error(`${label}: invalid sector in chain`);
    }
    if (seen.has(current)) throw new Error(`${label}: sector chain cycle`);
    seen.add(current);
    result.push(current);
    if (result.length > maximum) throw new Error(`${label}: sector chain exceeds file bounds`);
    current = table[current];
    if (current === CFB_FREE || current === CFB_FAT || current === CFB_DIFAT) {
      throw new Error(`${label}: special sector inside stream chain`);
    }
  }
  return result;
}

function readCfbStreamFromSectors(chain, readSector, size, sectorSize, label) {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error(`${label}: invalid stream size`);
  const expected = Math.ceil(size / sectorSize);
  if (chain.length !== expected) throw new Error(`${label}: stream chain length mismatch`);
  if (size === 0) return Buffer.alloc(0);
  return Buffer.concat(chain.map((sector) => readSector(sector, label)), chain.length * sectorSize).subarray(
    0,
    size,
  );
}

function cfbDirectoryEntry(bytes, offset, majorVersion) {
  const nameLength = bytes.readUInt16LE(offset + 64);
  const type = bytes[offset + 66];
  if (type === 0) return null;
  if (nameLength < 2 || nameLength > 64 || nameLength % 2 !== 0) {
    throw new Error("HWP5 CFB: invalid directory name length");
  }
  if (bytes.readUInt16LE(offset + nameLength - 2) !== 0) {
    throw new Error("HWP5 CFB: directory name is not terminated");
  }
  const name = bytes.subarray(offset, offset + nameLength - 2).toString("utf16le");
  const start = bytes.readUInt32LE(offset + 116);
  const lowSize = bytes.readUInt32LE(offset + 120);
  const highSize = majorVersion === 4 ? bytes.readUInt32LE(offset + 124) : 0;
  const size = highSize * 0x1_0000_0000 + lowSize;
  if (!Number.isSafeInteger(size)) throw new Error(`HWP5 CFB: stream ${name} is too large`);
  return { name, type, start, size };
}

/** Verify a CFB container and read the HWP5 FileHeader stream through FAT/miniFAT. */
export function inspectStrictHwp5Cfb(bytes) {
  if (bytes.length < 512 || !bytes.subarray(0, 8).equals(HWP_CFB_MAGIC)) {
    throw new Error("HWP5: full CFB magic mismatch (HTML/error page or wrong file)");
  }
  const majorVersion = bytes.readUInt16LE(26);
  const byteOrder = bytes.readUInt16LE(28);
  const sectorShift = bytes.readUInt16LE(30);
  const miniSectorShift = bytes.readUInt16LE(32);
  const sectorSize = 2 ** sectorShift;
  const miniSectorSize = 2 ** miniSectorShift;
  if (
    (majorVersion !== 3 && majorVersion !== 4) ||
    byteOrder !== 0xfffe ||
    sectorShift !== (majorVersion === 3 ? 9 : 12) ||
    miniSectorShift !== 6 ||
    bytes.readUInt32LE(56) !== 4096
  ) {
    throw new Error("HWP5 CFB: unsupported or malformed compound-file header");
  }
  const { sectorCount, readSector } = cfbSectorReader(bytes, sectorSize);
  const fatCount = bytes.readUInt32LE(44);
  const firstDirectorySector = bytes.readUInt32LE(48);
  const firstMiniFatSector = bytes.readUInt32LE(60);
  const miniFatSectorCount = bytes.readUInt32LE(64);
  let nextDifatSector = bytes.readUInt32LE(68);
  const difatSectorCount = bytes.readUInt32LE(72);
  if (fatCount < 1 || fatCount > sectorCount || difatSectorCount > sectorCount) {
    throw new Error("HWP5 CFB: FAT/DIFAT count exceeds file bounds");
  }

  const fatSectors = [];
  for (let offset = 76; offset < 512; offset += 4) {
    const sector = bytes.readUInt32LE(offset);
    if (sector !== CFB_FREE) fatSectors.push(sector);
  }
  const difatSectors = [];
  const difatEntriesPerSector = sectorSize / 4 - 1;
  for (let index = 0; index < difatSectorCount; index++) {
    if (!regularCfbSector(nextDifatSector)) throw new Error("HWP5 CFB: invalid DIFAT chain");
    if (difatSectors.includes(nextDifatSector)) throw new Error("HWP5 CFB: DIFAT cycle");
    difatSectors.push(nextDifatSector);
    const sector = readSector(nextDifatSector, "HWP5 CFB DIFAT");
    for (let entry = 0; entry < difatEntriesPerSector; entry++) {
      const fatSector = sector.readUInt32LE(entry * 4);
      if (fatSector !== CFB_FREE) fatSectors.push(fatSector);
    }
    nextDifatSector = sector.readUInt32LE(sectorSize - 4);
  }
  if (nextDifatSector !== CFB_END) throw new Error("HWP5 CFB: DIFAT chain does not terminate");
  if (fatSectors.length !== fatCount || new Set(fatSectors).size !== fatSectors.length) {
    throw new Error("HWP5 CFB: FAT sector count/uniqueness mismatch");
  }
  if (fatSectors.some((sector) => !regularCfbSector(sector) || sector >= sectorCount)) {
    throw new Error("HWP5 CFB: invalid FAT sector");
  }
  const fat = [];
  for (const sectorId of fatSectors) {
    const sector = readSector(sectorId, "HWP5 CFB FAT");
    for (let offset = 0; offset < sectorSize; offset += 4) fat.push(sector.readUInt32LE(offset));
  }
  for (const sector of fatSectors) {
    if (fat[sector] !== CFB_FAT) throw new Error("HWP5 CFB: FAT sector marker mismatch");
  }
  for (const sector of difatSectors) {
    if (fat[sector] !== CFB_DIFAT) throw new Error("HWP5 CFB: DIFAT sector marker mismatch");
  }

  const directoryChain = walkCfbChain(
    firstDirectorySector,
    fat,
    sectorCount,
    "HWP5 CFB directory",
  );
  if (directoryChain.length === 0) throw new Error("HWP5 CFB: directory stream is missing");
  const directory = Buffer.concat(
    directoryChain.map((sector) => readSector(sector, "HWP5 CFB directory")),
    directoryChain.length * sectorSize,
  );
  const entries = [];
  for (let offset = 0; offset + 128 <= directory.length; offset += 128) {
    const entry = cfbDirectoryEntry(directory, offset, majorVersion);
    if (entry) entries.push(entry);
  }
  const roots = entries.filter((entry) => entry.type === 5 && entry.name === "Root Entry");
  const fileHeaders = entries.filter((entry) => entry.type === 2 && entry.name === "FileHeader");
  if (roots.length !== 1 || fileHeaders.length !== 1) {
    throw new Error("HWP5 CFB: one Root Entry and one FileHeader stream are required");
  }
  const root = roots[0];
  const fileHeader = fileHeaders[0];
  if (fileHeader.size !== 256) throw new Error("HWP5 CFB: FileHeader stream must be 256 bytes");
  const readRegularStream = (entry, label) => {
    const chain = walkCfbChain(entry.start, fat, sectorCount, label);
    return readCfbStreamFromSectors(chain, readSector, entry.size, sectorSize, label);
  };

  let fileHeaderBytes;
  if (fileHeader.size < 4096) {
    if (miniFatSectorCount < 1 || miniFatSectorCount > sectorCount) {
      throw new Error("HWP5 CFB: miniFAT is required for FileHeader");
    }
    const miniFatChain = walkCfbChain(
      firstMiniFatSector,
      fat,
      sectorCount,
      "HWP5 CFB miniFAT",
    );
    if (miniFatChain.length !== miniFatSectorCount) {
      throw new Error("HWP5 CFB: miniFAT chain length mismatch");
    }
    const miniFatBytes = Buffer.concat(
      miniFatChain.map((sector) => readSector(sector, "HWP5 CFB miniFAT")),
      miniFatChain.length * sectorSize,
    );
    const miniFat = [];
    for (let offset = 0; offset < miniFatBytes.length; offset += 4) {
      miniFat.push(miniFatBytes.readUInt32LE(offset));
    }
    const rootMiniStream = readRegularStream(root, "HWP5 CFB root mini stream");
    const miniChain = walkCfbChain(
      fileHeader.start,
      miniFat,
      Math.ceil(rootMiniStream.length / miniSectorSize),
      "HWP5 CFB FileHeader mini stream",
    );
    const expectedMiniSectors = Math.ceil(fileHeader.size / miniSectorSize);
    if (miniChain.length !== expectedMiniSectors) {
      throw new Error("HWP5 CFB: FileHeader mini stream length mismatch");
    }
    const parts = miniChain.map((sector) => {
      const offset = sector * miniSectorSize;
      if (offset + miniSectorSize > rootMiniStream.length) {
        throw new Error("HWP5 CFB: FileHeader mini sector exceeds root stream");
      }
      return rootMiniStream.subarray(offset, offset + miniSectorSize);
    });
    fileHeaderBytes = Buffer.concat(parts, parts.length * miniSectorSize).subarray(
      0,
      fileHeader.size,
    );
  } else {
    fileHeaderBytes = readRegularStream(fileHeader, "HWP5 CFB FileHeader");
  }
  if (
    fileHeaderBytes.length < 32 ||
    !fileHeaderBytes.subarray(0, HWP_FILE_HEADER_SIGNATURE.length).equals(HWP_FILE_HEADER_SIGNATURE) ||
    fileHeaderBytes.subarray(HWP_FILE_HEADER_SIGNATURE.length, 32).some((byte) => byte !== 0)
  ) {
    throw new Error("HWP5 CFB: FileHeader stream signature mismatch");
  }
  if (fileHeaderBytes[35] !== 5) throw new Error("HWP5 CFB: FileHeader does not declare HWP major 5");
  return { sectors: sectorCount, fileHeaderBytes: fileHeaderBytes.length };
}
