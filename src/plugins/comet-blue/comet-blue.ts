import type {
	ConnectionManager,
	SessionOptions,
} from "../../connections/connection-manager";
import { GatewayError } from "../../lib/gateway-error";
import { normalizeUuid } from "../../lib/uuid";

const pinCharacteristic = "47e9ee30-47e9-11e4-8939-164230d1df67";
const temperaturesCharacteristic = "47e9ee2b-47e9-11e4-8939-164230d1df67";
const batteryCharacteristic = "47e9ee2c-47e9-11e4-8939-164230d1df67";

interface CometBlueStatus {
	temperature?: number;
	manualSetpoint?: number;
	ecoSetpoint?: number;
	comfortSetpoint?: number;
	battery?: number;
}

/**
 * Reads protected Comet Blue values using the PIN supplied for this request.
 *
 * @param connections Active gateway connection manager.
 * @param address MAC address of the thermostat.
 * @param pin Thermostat PIN as a decimal string.
 * @param options Gateway and address type the caller asked for
 */
export async function readCometBlue(
	connections: Pick<ConnectionManager, "withSession">,
	address: string,
	pin: unknown,
	options: SessionOptions = {},
): Promise<CometBlueStatus> {
	if (
		typeof pin !== "string" ||
		!/^\d{1,10}$/.test(pin) ||
		Number(pin) > 0xffffffff
	) {
		throw new GatewayError(
			"INVALID_PAYLOAD",
			'"pin" must be the thermostat PIN in decimal digits',
		);
	}
	return connections.withSession(
		address,
		async (session) => {
			const services = await session.getServices();
			const service = services.find(({ characteristics }) => {
				const ids = characteristics.map(({ uuid }) =>
					normalizeUuid(uuid),
				);
				return (
					ids.includes(pinCharacteristic) &&
					ids.includes(temperaturesCharacteristic)
				);
			});
			if (!service) {
				throw new GatewayError(
					"GATT_ERROR",
					"Comet Blue PIN and temperature characteristics were not found",
				);
			}

			const access = Buffer.alloc(4);
			access.writeUInt32LE(Number(pin));
			await session.write(service.uuid, pinCharacteristic, access, true);

			const data = await session.read(
				service.uuid,
				temperaturesCharacteristic,
			);
			if (data.length !== 7) {
				throw new GatewayError(
					"GATT_ERROR",
					"Invalid Comet Blue temperature data",
				);
			}

			const status: CometBlueStatus = {};
			const fields = [
				"temperature",
				"manualSetpoint",
				"ecoSetpoint",
				"comfortSetpoint",
			] as const;
			for (const [offset, field] of fields.entries()) {
				const value = data.readInt8(offset);
				if (value !== -128) {
					status[field] = value / 2;
				}
			}

			const batteryService = services.find(({ characteristics }) =>
				characteristics.some(
					({ uuid }) => normalizeUuid(uuid) === batteryCharacteristic,
				),
			);
			if (batteryService) {
				const value = await session.read(
					batteryService.uuid,
					batteryCharacteristic,
				);
				if (value.length === 1 && value[0] <= 100) {
					status.battery = value[0];
				}
			}
			return status;
		},
		options,
	);
}
