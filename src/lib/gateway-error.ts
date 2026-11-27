import type { GatewayErrorCode, GatewayResponse } from "./gateway-protocol";

/** An error with one of the codes of the gateway interface */
export class GatewayError extends Error {
	/**
	 * Creates the error with its code and a message for the log
	 *
	 * @param code One of the error codes of the gateway interface
	 * @param message What went wrong
	 */
	public constructor(
		public readonly code: GatewayErrorCode,
		message: string,
	) {
		super(message);
		this.name = "GatewayError";
	}
}

/**
 * The answer to send for an error. Anything that is not a GatewayError becomes GATT_ERROR.
 *
 * @param error What was thrown or rejected
 */
export function toErrorResponse(error: unknown): GatewayResponse<never> {
	if (error instanceof GatewayError) {
		return { error: { code: error.code, message: error.message } };
	}
	return {
		error: { code: "GATT_ERROR", message: normalizeError(error).message },
	};
}

/**
 * Preserves Error instances and wraps other rejection reasons.
 *
 * @param error The rejection reason.
 */
export function normalizeError(error: unknown): Error {
	if (error instanceof Error) {
		return error;
	}
	if (
		typeof error === "string" ||
		typeof error === "number" ||
		typeof error === "boolean"
	) {
		return new Error(String(error));
	}
	return new Error("Unknown error", { cause: error });
}

/**
 * The message of anything that was thrown
 *
 * @param error The rejection reason
 */
export function errorMessage(error: unknown): string {
	return normalizeError(error).message;
}

/**
 * Runs a command and turns its result or error into an answer of the gateway interface
 *
 * @param run The command, may throw a GatewayError
 */
export async function toResponse<T>(
	run: () => Promise<T>,
): Promise<GatewayResponse<T>> {
	try {
		return { error: null, result: await run() };
	} catch (e) {
		return toErrorResponse(e);
	}
}
