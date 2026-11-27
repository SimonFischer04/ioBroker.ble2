import type {
	ConnectionManager,
	SessionOptions,
} from "../../connections/connection-manager";
import { GatewayError } from "../../lib/gateway-error";

const SERVICE = "0000ffe0-0000-1000-8000-00805f9b34fb";
const SLOT_DATA = "0000ffe1-0000-1000-8000-00805f9b34fb";
const HEADER = 0x0f;
const QUERY = 0x55;
const FRAME_LENGTH = 20;

interface SlotReading {
	slot: number;
	status: number;
	elapsedSeconds: number;
	voltage: number;
	current: number;
	capacity: number;
	temperature: number;
}

function checksum(frame: Buffer): number {
	return frame.subarray(0, -1).reduce((sum, byte) => sum + byte, 0) & 0xff;
}

/**
 * Reads one charging slot through the MC3000 status query.
 *
 * @param connections
 * @param address
 * @param slot Slot number from 1 to 4
 * @param options Gateway and address type the caller asked for
 */
export async function readSkyrcMc3000Slot(
	connections: ConnectionManager,
	address: string,
	slot: number,
	options: SessionOptions = {},
): Promise<SlotReading> {
	const channel = slot - 1;
	return connections.withSession(
		address,
		async (session) => {
			const services = await session.getServices();
			const characteristic = services
				.find(({ uuid }) => uuid === SERVICE)
				?.characteristics.find(({ uuid }) => uuid === SLOT_DATA);
			const properties = characteristic?.properties ?? 0;
			if (!(properties & 0x10) || !(properties & 0x0c)) {
				throw new GatewayError(
					"GATT_ERROR",
					"The MC3000 status characteristic was not found",
				);
			}
			const reply = Promise.withResolvers<Buffer>();
			await session.subscribe(SERVICE, SLOT_DATA, (data) => {
				if (
					data.length === FRAME_LENGTH &&
					data[0] === HEADER &&
					data[1] === QUERY &&
					data[2] === channel &&
					data[FRAME_LENGTH - 1] === checksum(data)
				) {
					reply.resolve(data);
				}
			});

			const request = Buffer.alloc(FRAME_LENGTH);
			request.set([HEADER, QUERY, channel]);
			request[FRAME_LENGTH - 1] = checksum(request);
			const timer = setTimeout(
				() =>
					reply.reject(
						new GatewayError(
							"TIMEOUT",
							"No MC3000 slot status received",
						),
					),
				4000,
			);
			try {
				const [, data] = await Promise.all([
					session.write(
						SERVICE,
						SLOT_DATA,
						request,
						(properties & 0x08) !== 0,
					),
					reply.promise,
				]);
				return {
					slot,
					status: data[6],
					elapsedSeconds: data.readUInt16BE(7),
					voltage: data.readUInt16BE(9) / 1000,
					current: data.readUInt16BE(11) / 1000,
					capacity: data.readUInt16BE(13),
					temperature: data[15],
				};
			} finally {
				clearTimeout(timer);
			}
		},
		options,
	);
}
