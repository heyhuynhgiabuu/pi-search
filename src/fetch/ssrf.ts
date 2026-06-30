import { isIP } from "node:net";
import { fetchError } from "./errors.js";

export type SsrfPolicy = {
	allowRanges: string[];
};

const BLOCKED_IPV4 = [
	{ start: ipv4ToInt("0.0.0.0"), end: ipv4ToInt("0.255.255.255") },
	{ start: ipv4ToInt("10.0.0.0"), end: ipv4ToInt("10.255.255.255") },
	{ start: ipv4ToInt("100.64.0.0"), end: ipv4ToInt("100.127.255.255") },
	{ start: ipv4ToInt("127.0.0.0"), end: ipv4ToInt("127.255.255.255") },
	{ start: ipv4ToInt("169.254.0.0"), end: ipv4ToInt("169.254.255.255") },
	{ start: ipv4ToInt("172.16.0.0"), end: ipv4ToInt("172.31.255.255") },
	{ start: ipv4ToInt("192.0.0.0"), end: ipv4ToInt("192.0.0.255") },
	{ start: ipv4ToInt("192.0.2.0"), end: ipv4ToInt("192.0.2.255") },
	{ start: ipv4ToInt("192.168.0.0"), end: ipv4ToInt("192.168.255.255") },
	{ start: ipv4ToInt("198.18.0.0"), end: ipv4ToInt("198.19.255.255") },
	{ start: ipv4ToInt("224.0.0.0"), end: ipv4ToInt("239.255.255.255") },
	{ start: ipv4ToInt("240.0.0.0"), end: ipv4ToInt("255.255.255.255") },
];

function ipv4ToInt(ip: string): number {
	const parts = ip.split(".").map((p) => Number.parseInt(p, 10));
	if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
		return -1;
	}
	return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function parseIpv4Cidr(cidr: string): { start: number; end: number } | null {
	const [ipPart, prefixPart] = cidr.split("/");
	if (!ipPart || prefixPart === undefined) return null;
	const prefix = Number.parseInt(prefixPart, 10);
	if (Number.isNaN(prefix) || prefix < 0 || prefix > 32) return null;
	const base = ipv4ToInt(ipPart.trim());
	if (base < 0) return null;
	if (prefix === 0) return { start: 0, end: 0xffffffff };
	const mask = prefix === 32 ? 0xffffffff : ~((1 << (32 - prefix)) - 1) >>> 0;
	const start = (base & mask) >>> 0;
	const end = (start | (~mask >>> 0)) >>> 0;
	return { start, end };
}

function ipv4InRange(ip: number, range: { start: number; end: number }): boolean {
	return ip >= range.start && ip <= range.end;
}

function isBlockedIpv4(ip: string): boolean {
	const n = ipv4ToInt(ip);
	if (n < 0) return true;
	for (const range of BLOCKED_IPV4) {
		if (ipv4InRange(n, range)) return true;
	}
	return false;
}

function isBlockedIpv6(ip: string): boolean {
	const lower = ip.toLowerCase();
	if (lower === "::1" || lower === "0:0:0:0:0:0:0:1") return true;
	if (lower.startsWith("fe80:")) return true;
	if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
	if (lower === "::" || lower === "0:0:0:0:0:0:0:0") return true;
	return false;
}

function isIpAllowedByRanges(ip: string, allowRanges: string[]): boolean {
	const version = isIP(ip);
	if (version === 4) {
		const n = ipv4ToInt(ip);
		if (n < 0) return false;
		for (const cidr of allowRanges) {
			const range = parseIpv4Cidr(cidr.trim());
			if (range && ipv4InRange(n, range)) return true;
		}
		return false;
	}
	// IPv6 allowlist: not implemented (reject unless we add parsing later)
	return false;
}

function isBlockedIp(ip: string, policy: SsrfPolicy): boolean {
	if (isIpAllowedByRanges(ip, policy.allowRanges)) return false;
	const version = isIP(ip);
	if (version === 4) return isBlockedIpv4(ip);
	if (version === 6) return isBlockedIpv6(ip);
	return true;
}

/** Reject dangerous fetch targets (localhost, RFC1918, link-local, etc.). */
export function assertSsrfAllowed(url: URL, policy: SsrfPolicy): void {
	const host = url.hostname.replace(/^\[|\]$/g, "");
	if (host === "localhost") {
		throw fetchError("fetch_blocked", "SSRF blocked: localhost", { url: url.toString() });
	}
	const version = isIP(host);
	if (version === 0) {
		// hostname — DNS rebinding is out of scope; block only literal IPs in URL
		return;
	}
	if (isBlockedIp(host, policy)) {
		throw fetchError("fetch_blocked", `SSRF blocked: ${host}`, { url: url.toString(), host });
	}
}

export function parseSsrfAllowRanges(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const out: string[] = [];
	for (const item of raw) {
		if (typeof item !== "string") continue;
		const cidr = item.trim();
		if (!cidr) continue;
		if (cidr === "0.0.0.0/0" || cidr === "::/0") continue;
		if (!parseIpv4Cidr(cidr)) continue;
		out.push(cidr);
	}
	return out;
}
