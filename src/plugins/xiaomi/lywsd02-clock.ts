import type {
	ConnectionManager,
	SessionOptions,
} from "../../connections/connection-manager";
import { GatewayError } from "../../lib/gateway-error";
import { normalizeUuid } from "../../lib/uuid";

const CLOCK = "ebe0ccb7-7a0a-4b0c-8a1a-6ff2997da3a6";

/**
 * Sets the factory firmware clock of an LYWSD02. The value is a Unix timestamp
 * in seconds followed by a signed UTC offset in whole hours.
 *
 * @param connections
 * @param address
 */
export async function syncLywsd02Clock(
	connections: ConnectionManager,
	address: string,
	options: SessionOptions = {},
): Promise<number> {
	return connections.withSession(
		address,
		async (session) => {
			const services = await session.getServices();
			const service = services.find(({ characteristics }) =>
				characteristics.some(
					({ uuid, properties }) =>
						normalizeUuid(uuid) === CLOCK &&
						(properties & 0x08) !== 0,
				),
			);
			if (!service) {
				throw new GatewayError(
					"GATT_ERROR",
					"The LYWSD02 clock was not found",
				);
			}

			const now = new Date();
			const timestamp = Math.floor(now.getTime() / 1000);
			const offsetHours = -now.getTimezoneOffset() / 60;
			if (
				timestamp < 0 ||
				timestamp > 0xffffffff ||
				!Number.isInteger(offsetHours)
			) {
				throw new GatewayError(
					"GATT_ERROR",
					"The LYWSD02 clock requires a Unix timestamp and a whole-hour UTC offset",
				);
			}

			const payload = Buffer.alloc(5);
			payload.writeUInt32LE(timestamp);
			payload.writeInt8(offsetHours, 4);
			await session.write(service.uuid, CLOCK, payload, true);
			return timestamp * 1000;
		},
		options,
	);
}
