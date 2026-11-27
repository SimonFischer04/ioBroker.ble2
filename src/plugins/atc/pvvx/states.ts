import { errorMessage } from "../../../lib/gateway-error";

/**
 * "<CODE>: <message>" of an error, as the states lastError and firmwareError show it. The code
 * is the one of a GatewayError or PvvxUpdateError, otherwise "ERROR".
 *
 * @param error Anything that was thrown
 */
export function describeError(error: unknown): string {
	const code = (error as { code?: unknown } | null | undefined)?.code;
	return `${typeof code === "string" ? code : "ERROR"}: ${errorMessage(error)}`;
}

/**
 * Writes states below <address>.pvvx, acknowledged. A failed write is reported, not thrown.
 * Stops as soon as isDisposed() returns true.
 *
 * @param adapter Writes the states and reports failures
 * @param address The device
 * @param values The values by state ID below <address>.pvvx
 * @param isDisposed Whether the adapter is stopping
 */
export async function writeStates(
	adapter: Pick<ioBroker.Adapter, "setStateAsync" | "log">,
	address: string,
	values: Record<string, ioBroker.StateValue>,
	isDisposed: () => boolean,
): Promise<void> {
	for (const [id, value] of Object.entries(values)) {
		if (isDisposed()) {
			return;
		}
		try {
			await adapter.setStateAsync(`${address}.pvvx.${id}`, value, true);
		} catch (e) {
			adapter.log.warn(
				`Could not write ${address}.pvvx.${id}: ${errorMessage(e)}`,
			);
		}
	}
}
