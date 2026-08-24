import type { ProposalV1 } from "./types";

export type ProposalDigestMaterial = Omit<ProposalV1, "proposal_id" | "digest">;

function utf8(value: string): number[] {
  const bytes: number[] = [];
  for (const char of value) {
    const cp = char.codePointAt(0)!;
    if (cp <= 0x7f) bytes.push(cp);
    else if (cp <= 0x7ff) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp <= 0xffff) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return bytes;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonical(record[key])]));
  }
  return value;
}

/** Cross-language Proposal v1 identity checksum. Commit authority comes from the engine-held pending
 *  snapshot plus session/document/revision binding; this digest exists to prove surface parity. */
export function canonicalProposalDigest(material: ProposalDigestMaterial): string {
  const bytes = utf8(JSON.stringify(canonical(material)));
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}
