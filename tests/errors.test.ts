import { describe, expect, it } from "vitest";
import {
	buildErrorResult,
	ConfigError,
	FetchError,
	McpError,
	PiSearchError,
	ProviderError,
	toPiSearchError,
	ValidationError,
} from "../src/errors.js";

describe("errors", () => {
	it("PiSearchError carries a stable code and JSON-serializes", () => {
		const err = new PiSearchError("validation_error", "bad", { param: "query" });
		expect(err.code).toBe("validation_error");
		expect(err.toJSON()).toEqual({ code: "validation_error", message: "bad", details: { param: "query" } });
	});

	it("subclasses preserve their narrow code", () => {
		expect(new ValidationError("x").code).toBe("validation_error");
		expect(new ConfigError("x").code).toBe("config_error");
		expect(new ProviderError("x").code).toBe("provider_error");
		expect(new McpError("mcp_timeout", "x").code).toBe("mcp_timeout");
		expect(new FetchError("fetch_error", "x").code).toBe("fetch_error");
	});

	it("toPiSearchError maps AbortError to 'aborted'", () => {
		const err = toPiSearchError(Object.assign(new Error("nope"), { name: "AbortError" }));
		expect(err.code).toBe("aborted");
	});

	it("toPiSearchError maps unknown errors to 'internal_error'", () => {
		const err = toPiSearchError(new Error("boom"));
		expect(err.code).toBe("internal_error");
		expect(err.details).toEqual({ originalName: "Error" });
	});

	it("toPiSearchError is idempotent for PiSearchError inputs", () => {
		const orig = new ValidationError("x", { foo: 1 });
		expect(toPiSearchError(orig)).toBe(orig);
	});

	it("toPiSearchError handles non-Error inputs", () => {
		expect(toPiSearchError("string").code).toBe("internal_error");
		expect(toPiSearchError({ weird: true }).code).toBe("internal_error");
		expect(toPiSearchError(null).code).toBe("internal_error");
	});

	it("buildErrorResult produces a stable envelope", () => {
		const err = new ValidationError("missing query", { param: "query" });
		const result = buildErrorResult(err);
		expect(result.content[0].text).toBe("Error: missing query");
		expect(result.details.error.code).toBe("validation_error");
		expect(result.details.error.details).toEqual({ param: "query" });
	});
});
