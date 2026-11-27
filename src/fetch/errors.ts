import { FetchError } from "../errors.js";

export type FetchErrorDetails = {
	url?: string;
	host?: string;
	status?: number;
	bytes?: number;
	totalPages?: number;
	owner?: string;
	repo?: string;
	path?: string;
	sha?: string;
};

export function fetchError(
	code: "fetch_error" | "fetch_blocked" | "fetch_timeout",
	message: string,
	details?: FetchErrorDetails,
): FetchError {
	return new FetchError(code, message, details);
}
