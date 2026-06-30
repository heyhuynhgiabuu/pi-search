import { FetchError } from "../errors.js";

export function fetchError(
	code: "fetch_error" | "fetch_blocked" | "fetch_timeout",
	message: string,
	details?: Record<string, unknown>,
): FetchError {
	return new FetchError(code, message, details);
}
