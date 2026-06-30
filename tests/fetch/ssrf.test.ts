import { describe, expect, it } from "vitest";
import { assertSsrfAllowed, parseSsrfAllowRanges } from "../../src/fetch/ssrf.js";

describe("parseSsrfAllowRanges", () => {
	it("rejects open CIDRs", () => {
		expect(parseSsrfAllowRanges(["0.0.0.0/0", "198.18.0.0/15", "bad"])).toEqual(["198.18.0.0/15"]);
	});
});

describe("assertSsrfAllowed", () => {
	it("blocks localhost", () => {
		expect(() => assertSsrfAllowed(new URL("http://localhost/foo"), { allowRanges: [] })).toThrow(/SSRF/);
	});

	it("blocks 127.0.0.1", () => {
		expect(() => assertSsrfAllowed(new URL("http://127.0.0.1/"), { allowRanges: [] })).toThrow(/SSRF/);
	});

	it("allows fake-ip range when configured", () => {
		expect(() => assertSsrfAllowed(new URL("http://198.18.0.42/"), { allowRanges: ["198.18.0.0/15"] })).not.toThrow();
	});
});
