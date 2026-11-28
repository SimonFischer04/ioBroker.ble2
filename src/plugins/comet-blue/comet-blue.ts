import type {
	ConnectionManager,
	SessionOptions,
} from "../../connections/connection-manager";
import type { GattSession } from "../../connections/gatt-session";
import type { GattServiceInfo } from "../../lib/gateway-protocol";
import { GatewayError } from "../../lib/gateway-error";

const pinCharacteristic = "47e9ee30-47e9-11e4-8939-164230d1df67";
const temperaturesCharacteristic = "47e9ee2b-47e9-11e4-8939-164230d1df67";
const batteryCharacteristic = "47e9ee2c-47e9-11e4-8939-164230d1df67";
const setpoints = ["manualSetpoint", "ecoSetpoint", "comfortSetpoint"] as const;
const unchanged = 0x80;

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
	const access = encodePin(pin);
	return connections.withSession(
		address,
		async (session) => {
			const { services, temperatureService } = await unlockThermostat(
				session,
				access,
			);
			const data = await readTemperatureBlock(
				session,
				temperatureService,
			);

			const status: CometBlueStatus = {};
			const fields = ["temperature", ...setpoints] as const;
			for (const [offset, field] of fields.entries()) {
				const value = data.readInt8(offset);
				if (value !== -128) {
					status[field] = value / 2;
				}
			}

			const batteryService = services.find(({ characteristics }) =>
				characteristics.some(
					({ uuid }) => uuid === batteryCharacteristic,
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

/**
 * Updates one or more Comet Blue setpoints using an authenticated session.
 *
 * @param connections Active gateway connection manager
 * @param address MAC address of the thermostat
 * @param payload Requested setpoints and existing PIN
 * @param options Gateway and address type selected by the caller
 */
export async function setCometBlueSetpoints(
	connections: Pick<ConnectionManager, "withSession">,
	address: string,
	payload: Record<string, unknown>,
	options: SessionOptions,
): Promise<void> {
	const access = encodePin(payload.pin);
	const block = Buffer.alloc(7, unchanged);
	let requested = false;
	for (const [index, field] of setpoints.entries()) {
		const value = payload[field];
		if (value === undefined) {
			continue;
		}
		if (
			typeof value !== "number" ||
			value < 8 ||
			value > 28 ||
			!Number.isInteger(value * 2)
		) {
			throw new GatewayError(
				"INVALID_PAYLOAD",
				`"${field}" must be 8–28 °C in half-degree increments`,
			);
		}
		block[index + 1] = value * 2;
		requested = true;
	}
	if (!requested) {
		throw new GatewayError(
			"INVALID_PAYLOAD",
			"Provide at least one Comet Blue setpoint",
		);
	}

	await connections.withSession(
		address,
		async (session) => {
			const { temperatureService } = await unlockThermostat(
				session,
				access,
			);
			const current = await readTemperatureBlock(
				session,
				temperatureService,
			);
			if (current[4] === unchanged) {
				throw new GatewayError(
					"GATT_ERROR",
					"Could not read the thermostat calibration offset",
				);
			}
			// This protocol requires the actual calibration offset even when it is unchanged.
			block[4] = current[4];
			await session.write(
				temperatureService,
				temperaturesCharacteristic,
				block,
				true,
			);
		},
		options,
	);
}

function encodePin(pin: unknown): Buffer {
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
	const access = Buffer.alloc(4);
	access.writeUInt32LE(Number(pin));
	return access;
}

async function unlockThermostat(
	session: GattSession,
	access: Buffer,
): Promise<{ services: GattServiceInfo[]; temperatureService: string }> {
	const services = await session.getServices();
	const service = services.find(({ characteristics }) => {
		const ids = characteristics.map(({ uuid }) => uuid);
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
	await session.write(service.uuid, pinCharacteristic, access, true);
	return { services, temperatureService: service.uuid };
}

async function readTemperatureBlock(
	session: GattSession,
	service: string,
): Promise<Buffer> {
	const data = await session.read(service, temperaturesCharacteristic);
	if (data.length !== 7) {
		throw new GatewayError(
			"GATT_ERROR",
			"Invalid Comet Blue temperature data",
		);
	}
	return data;
}
