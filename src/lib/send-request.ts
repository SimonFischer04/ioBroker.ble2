import { errorMessage, GatewayError } from "./gateway-error";
import type { GatewayErrorCode } from "./gateway-protocol";

/** What sendRequest needs from the adapter */
export interface RequestSender {
	/** Sends a message to another instance, like adapter.sendTo */
	sendTo(
		instance: string,
		command: string,
		message: unknown,
		callback: (response: unknown) => void,
	): void;
	/** Starts a timer, like adapter.setTimeout */
	setTimeout(callback: () => void, ms: number): unknown;
	/** Stops a timer started with setTimeout */
	clearTimeout(timer: any): void;
}

/**
 * Sends a command to another instance and resolves with the `result` of its answer.
 * Rejects with a GatewayError: the error of the answer, TIMEOUT if none arrived in time,
 * GATT_ERROR if the answer has an unknown form.
 *
 * @param adapter Sends the message and runs the timer
 * @param instance The receiving instance, e.g. "esphome.0"
 * @param command The command, e.g. "gatt:read"
 * @param message The payload of the command
 * @param timeoutMs How long to wait for the answer
 */
export function sendRequest<T>(
	adapter: RequestSender,
	instance: string,
	command: string,
	message: unknown,
	timeoutMs: number,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const timer = adapter.setTimeout(() => {
			if (settled) {
				return;
			}
			settled = true;
			reject(
				new GatewayError(
					"TIMEOUT",
					`No answer to ${command} from ${instance} within ${timeoutMs} ms`,
				),
			);
		}, timeoutMs);

		const settle = (fn: () => void): void => {
			if (settled) {
				return;
			}
			settled = true;
			adapter.clearTimeout(timer);
			fn();
		};

		try {
			adapter.sendTo(instance, command, message, (response) => {
				settle(() => {
					const answer = response as Record<string, any> | undefined;
					if (
						answer != null &&
						typeof answer === "object" &&
						!(answer instanceof Error)
					) {
						if (answer.error === null && "result" in answer) {
							resolve(answer.result as T);
							return;
						}
						if (
							answer.error != null &&
							typeof answer.error === "object" &&
							typeof answer.error.code === "string"
						) {
							reject(
								new GatewayError(
									answer.error.code as GatewayErrorCode,
									typeof answer.error.message === "string"
										? answer.error.message
										: answer.error.code,
								),
							);
							return;
						}
					}
					reject(
						new GatewayError(
							"GATT_ERROR",
							`Unexpected answer to ${command}`,
						),
					);
				});
			});
		} catch (e) {
			settle(() =>
				reject(new GatewayError("GATT_ERROR", errorMessage(e))),
			);
		}
	});
}
