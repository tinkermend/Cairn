/**
 * Browser-safe IP/CIDR normalization used by service access policy.
 *
 * Keep this implementation here instead of depending on a Node-only parser: callers
 * edit allowlists in the Web console, while the API and DB must make exactly the
 * same decision. Invalid syntax is rejected rather than interpreted loosely.
 */
type ParsedAddress = {
  family: 4 | 6;
  value: bigint;
};

const IPV4_BITS = 32;
const IPV6_BITS = 128;
const IPV4_MAX = (1n << 32n) - 1n;

function parseIpv4(value: string): ParsedAddress | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  let parsed = 0n;
  for (const part of parts) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    parsed = (parsed << 8n) | BigInt(octet);
  }
  return { family: 4, value: parsed };
}

function parseIpv6(value: string): ParsedAddress | null {
  if (!value || value.includes("%")) return null;
  const compressedAt = value.indexOf("::");
  if (compressedAt !== -1 && value.indexOf("::", compressedAt + 1) !== -1)
    return null;
  const left =
    compressedAt === -1
      ? value.split(":")
      : value.slice(0, compressedAt).split(":");
  const right =
    compressedAt === -1 ? [] : value.slice(compressedAt + 2).split(":");
  if (left.length === 1 && left[0] === "") left.length = 0;
  if (right.length === 1 && right[0] === "") right.length = 0;
  const raw = [...left, ...right];
  const groups: number[] = [];
  for (const [index, group] of raw.entries()) {
    if (!group) return null;
    if (group.includes(".")) {
      // An embedded IPv4 tail owns the final 32 bits. It cannot appear before a
      // compression marker such as `192.0.2.1::`, even if it is the final raw
      // token on the left side.
      if (
        index !== raw.length - 1 ||
        (compressedAt !== -1 && index < left.length)
      )
        return null;
      const ipv4 = parseIpv4(group);
      if (!ipv4) return null;
      groups.push(
        Number((ipv4.value >> 16n) & 0xffffn),
        Number(ipv4.value & 0xffffn),
      );
      continue;
    }
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    groups.push(Number.parseInt(group, 16));
  }
  if (compressedAt === -1 ? groups.length !== 8 : groups.length >= 8)
    return null;
  if (compressedAt !== -1)
    groups.splice(left.length, 0, ...Array(8 - groups.length).fill(0));
  if (groups.length !== 8) return null;
  let parsed = 0n;
  for (const group of groups) parsed = (parsed << 16n) | BigInt(group);
  return { family: 6, value: parsed };
}

function parseAddress(value: string): ParsedAddress | null {
  return parseIpv4(value) ?? parseIpv6(value);
}

function formatIpv4(value: bigint): string {
  return [24n, 16n, 8n, 0n]
    .map((shift) => String(Number((value >> shift) & 0xffn)))
    .join(".");
}

function formatIpv6(value: bigint): string {
  const groups = Array.from({ length: 8 }, (_, index) =>
    Number((value >> BigInt((7 - index) * 16)) & 0xffffn),
  );
  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < groups.length;) {
    if (groups[index] !== 0) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < groups.length && groups[index] === 0) index += 1;
    const length = index - start;
    if (length >= 2 && length > bestLength) {
      bestStart = start;
      bestLength = length;
    }
  }
  if (bestStart === 0 && bestLength === 8) return "::";
  const words = groups.map((group) => group.toString(16));
  if (bestStart === -1) return words.join(":");
  const before = words.slice(0, bestStart).join(":");
  const after = words.slice(bestStart + bestLength).join(":");
  return `${before}::${after}`;
}

function isIpv4Mapped(address: ParsedAddress): boolean {
  return address.family === 6 && address.value >> 32n === 0xffffn;
}

function toCanonicalAddress(address: ParsedAddress): ParsedAddress {
  return isIpv4Mapped(address)
    ? { family: 4, value: address.value & IPV4_MAX }
    : address;
}

function formatAddress(address: ParsedAddress): string {
  return address.family === 4
    ? formatIpv4(address.value)
    : formatIpv6(address.value);
}

function bitsFor(address: ParsedAddress): number {
  return address.family === 4 ? IPV4_BITS : IPV6_BITS;
}

function network(value: bigint, bits: number, prefix: number): bigint {
  const remaining = BigInt(bits - prefix);
  return remaining === 0n ? value : (value >> remaining) << remaining;
}

/** Returns a canonical IPv4 or IPv6 literal, or null for invalid input. */
export function normalizeIpAddress(
  raw: string | null | undefined,
): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || value.includes("/")) return null;
  const parsed = parseAddress(value);
  return parsed ? formatAddress(toCanonicalAddress(parsed)) : null;
}

/**
 * Normalizes one allowlist item. Host bits in CIDR entries are cleared so equivalent
 * policies serialize identically; a full-length prefix serializes as a host literal.
 */
export function normalizeIpCidr(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  const slash = value.indexOf("/");
  if (slash === -1) return normalizeIpAddress(value);
  if (
    slash !== value.lastIndexOf("/") ||
    slash === 0 ||
    slash === value.length - 1
  )
    return null;
  const parsed = parseAddress(value.slice(0, slash));
  const prefixText = value.slice(slash + 1);
  if (!parsed || !/^[0-9]{1,3}$/.test(prefixText)) return null;
  const prefix = Number(prefixText);
  const bits = bitsFor(parsed);
  if (prefix < 0 || prefix > bits) return null;
  // Do not turn an IPv4-mapped IPv6 CIDR into a different, surprising policy.
  if (isIpv4Mapped(parsed)) return null;
  const normalized = { ...parsed, value: network(parsed.value, bits, prefix) };
  return prefix === bits
    ? formatAddress(normalized)
    : `${formatAddress(normalized)}/${prefix}`;
}

/** Normalizes, bounds, and de-duplicates an edited IP/CIDR allowlist. */
export function normalizeIpAllowlist(
  entries: readonly string[],
): string[] | null {
  if (entries.length > 64) return null;
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const value = normalizeIpCidr(entry);
    if (!value || seen.has(value)) return null;
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

function parseCidr(
  value: string,
): { address: ParsedAddress; prefix: number } | null {
  const slash = value.indexOf("/");
  if (slash === -1) {
    const address = parseAddress(value);
    return address ? { address, prefix: bitsFor(address) } : null;
  }
  const address = parseAddress(value.slice(0, slash));
  const prefix = Number(value.slice(slash + 1));
  if (
    !address ||
    !Number.isInteger(prefix) ||
    prefix < 0 ||
    prefix > bitsFor(address)
  )
    return null;
  return { address, prefix };
}

/** Empty allowlists allow every valid source. A non-empty list fails closed on unknown IPs. */
export function isIpAllowedByAllowlist(
  clientIp: string | null | undefined,
  allowlist: readonly string[],
): boolean {
  if (allowlist.length === 0) return true;
  const normalized = normalizeIpAddress(clientIp);
  const candidate = normalized ? parseAddress(normalized) : null;
  if (!candidate) return false;
  for (const value of allowlist) {
    const rule = parseCidr(value);
    if (!rule || rule.address.family !== candidate.family) continue;
    const bits = bitsFor(candidate);
    if (
      network(candidate.value, bits, rule.prefix) ===
      network(rule.address.value, bits, rule.prefix)
    )
      return true;
  }
  return false;
}
