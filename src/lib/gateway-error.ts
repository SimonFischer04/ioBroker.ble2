import type { GatewayErrorCode, GatewayResponse } from "./gateway-protocol";

/** An error with one of the codes of the gateway interface */
export class GatewayError extends Error {
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
 * @param error
 */
export function toErrorResponse(error: unknown): GatewayResponse<never> {
	if (error instanceof GatewayError) {
		return { error: { code: error.code, message: error.message } };
	}
	return {
		error: { code: "GATT_ERROR", message: normalizeError(error).message },
	};
}

/** Preserves Error instances and wraps other rejection reasons.
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
