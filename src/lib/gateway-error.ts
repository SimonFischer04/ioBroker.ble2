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

/** The answer to send for an error. Anything that is not a GatewayError becomes GATT_ERROR. */
export function toErrorResponse(error: unknown): GatewayResponse<never> {
	if (error instanceof GatewayError) {
		return { error: { code: error.code, message: error.message } };
	}
	const message =
		error instanceof Error
			? error.message
			: String(error ?? "Unknown error");
	return { error: { code: "GATT_ERROR", message } };
}
