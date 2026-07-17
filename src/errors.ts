/**
 * Coded errors for pi-search tools.
 *
 * Every tool catches thrown errors and returns a structured
 * `{ content, details: { error: { code, message, ... } } }` shape
 * so the model can branch on stable `code` strings instead of
 * parsing free-form error messages.
 *
 * Codes are intentionally kebab-style strings and **stable across versions**.
 * Adding a new code is non-breaking. Changing or removing a code is breaking.
 */

export type ErrorCode =
	// config
	| "config_error"
	| "missing_api_key"
	// validation
	| "validation_error"
	| "missing_query"
	| "invalid_query"
	| "invalid_num_results"
	| "invalid_max_tokens"
	// exa provider
	| "provider_error"
	| "exa_unauthorized"
	| "exa_rate_limited"
	| "exa_timeout"
	// firecrawl provider
	| "firecrawl_auth_error"
	| "firecrawl_rate_limited"
	| "firecrawl_timeout"
	// mcp
	| "mcp_error"
	| "mcp_timeout"
	| "mcp_unavailable"
	// web fetch
	| "fetch_error"
	| "fetch_blocked"
	| "fetch_timeout"
	// generic
	| "internal_error"
	| "aborted";

export class PiSearchError extends Error {
	readonly code: ErrorCode;
	readonly details?: Record<string, unknown>;

	constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
		super(message);
		this.name = "PiSearchError";
		this.code = code;
		this.details = details;
	}

	toJSON(): { code: ErrorCode; message: string; details?: Record<string, unknown> } {
		return {
			code: this.code,
			message: this.message,
			...(this.details ? { details: this.details } : {}),
		};
	}
}

export class ValidationError extends PiSearchError {
	constructor(message: string, details?: Record<string, unknown>) {
		super("validation_error", message, details);
		this.name = "ValidationError";
	}
}

export class ConfigError extends PiSearchError {
	constructor(message: string, details?: Record<string, unknown>) {
		super("config_error", message, details);
		this.name = "ConfigError";
	}
}

export class ProviderError extends PiSearchError {
	constructor(message: string, details?: Record<string, unknown>) {
		super("provider_error", message, details);
		this.name = "ProviderError";
	}
}

export class McpError extends PiSearchError {
	constructor(
		code: Extract<ErrorCode, "mcp_error" | "mcp_timeout" | "mcp_unavailable">,
		message: string,
		details?: Record<string, unknown>,
	) {
		super(code, message, details);
		this.name = "McpError";
	}
}

export class FetchError extends PiSearchError {
	constructor(
		code: Extract<ErrorCode, "fetch_error" | "fetch_blocked" | "fetch_timeout">,
		message: string,
		details?: Record<string, unknown>,
	) {
		super(code, message, details);
		this.name = "FetchError";
	}
}

/**
 * Map raw error → PiSearchError with a stable code.
 * Used as the last line of defense in tool execute() handlers.
 */
export function toPiSearchError(error: unknown): PiSearchError {
	if (error instanceof PiSearchError) return error;
	if (error instanceof Error) {
		// Recognize common fetch/Abort shapes
		if (error.name === "AbortError") {
			return new PiSearchError("aborted", error.message);
		}
		return new PiSearchError("internal_error", error.message, { originalName: error.name });
	}
	return new PiSearchError("internal_error", String(error));
}

/**
 * Build the standard error result envelope.
 * Mirrors pi-exa-search's `buildErrorResult` for consistency.
 */
export function buildErrorResult(error: PiSearchError): {
	content: Array<{ type: "text"; text: string }>;
	details: { error: ReturnType<PiSearchError["toJSON"]> };
} {
	return {
		content: [{ type: "text", text: `Error: ${error.message}` }],
		details: { error: error.toJSON() },
	};
}
