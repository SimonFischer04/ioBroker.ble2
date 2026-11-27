import type {
	ConnectionManager,
	SessionOptions,
} from "../../connections/connection-manager";
import { GatewayError } from "../../lib/gateway-error";

const CONTROL_HANDLE = 0x001f;

/**
 * Sets the brightness of a Yeelight Candela YLFW01YL.
 *
 * @param connections
 * @param address
 * @param brightness
 */
export async function setCandelaBrightness(
	connections: ConnectionManager,
	address: string,
	brightness: number,
	options: SessionOptions = {},
): Promise<void> {
	await connections.withSession(
		address,
		async (session) => {
			// The YLFW01YL protocol identifies its command characteristic by ATT handle.
			const services = await session.getServices();
			for (const { uuid, characteristics } of services) {
				const control = characteristics.find(
					({ handle, properties }) =>
						handle === CONTROL_HANDLE && (properties & 0x08) !== 0,
				);
				if (!control) {
					continue;
				}
				await session.write(
					uuid,
					control.uuid,
					Buffer.from([0x43, 0x40, brightness === 0 ? 0x02 : 0x01]),
					true,
				);
				if (brightness > 0) {
					await session.write(
						uuid,
						control.uuid,
						Buffer.from([0x43, 0x42, brightness]),
						true,
					);
				}
				return;
			}
			throw new GatewayError(
				"GATT_ERROR",
				"The Candela control characteristic was not found",
			);
		},
		options,
	);
}
