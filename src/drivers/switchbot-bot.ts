import type { ConnectionManager } from "../connections/connection-manager";
import { GatewayError } from "../lib/gateway-error";

const service = "cba20d00-224d-11e6-9fb8-0002a5d5c51b";
const commandCharacteristic = "cba20002-224d-11e6-9fb8-0002a5d5c51b";
const responseCharacteristic = "cba20003-224d-11e6-9fb8-0002a5d5c51b";
const actions = new Map([
	["press", 0x00],
	["on", 0x01],
	["off", 0x02],
	["stop", 0x03],
]);

/**
 * Requests an action from a SwitchBot Bot and waits for its firmware response.
 *
 * @param connections The gateway connection manager.
 * @param address The normalized Bot MAC address.
 * @param action The requested action.
 */
export async function runSwitchBotAction(
	connections: Pick<ConnectionManager, "withSession">,
	address: string,
	action: unknown,
): Promise<Record<string, never>> {
	const value = typeof action === "string" ? actions.get(action) : undefined;
	if (value == null) {
		throw new GatewayError(
			"INVALID_PAYLOAD",
			'"action" must be press, on, off, or stop',
		);
	}

	return connections.withSession(
		address,
		async (session) => {
			let wroteCommand = false;
			let onStatus: (status: number) => void;
			const response = new Promise<number>((resolve) => {
				onStatus = resolve;
			});

			await session.subscribe(service, responseCharacteristic, (data) => {
				if (wroteCommand && data.length > 0) {
					onStatus(data[0]);
				}
			});

			wroteCommand = true;
			await session.write(
				service,
				commandCharacteristic,
				Buffer.from([0x57, 0x01, value]),
				true,
			);
			const status = await response;
			if (status !== 1) {
				throw new GatewayError(
					"GATT_ERROR",
					`SwitchBot rejected the action (status 0x${status.toString(16).padStart(2, "0")})`,
				);
			}
			return {};
		},
		{ timeoutMs: 30_000 },
	);
}
