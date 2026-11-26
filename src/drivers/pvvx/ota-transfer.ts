import type { GattSession } from "../../connections/gatt-session";
import {
	encodeDataPacket,
	encodeEndPacket,
	OTA_CHARACTERISTIC,
	OTA_CMD_START,
	OTA_CMD_VERSION,
	OTA_SERVICE,
	OTA_WRITE_WITH_RESPONSE,
	otaStatusText,
	PACKETS_PER_STATUS_READ,
	toBlocks,
} from "./ota-protocol";
import { PvvxUpdateError } from "./update-error";

/** Pause after the start command, value of both reference clients */
const START_DELAY_MS = 300;

export interface TransferOptions {
	/** Called after every status read and at the end, with values from 0 to 1 */
	onProgress(fraction: number): void;
	/** Waits, the adapter passes its timers */
	sleep(ms: number): Promise<void>;
}

/**
 * Transfers the image (docs/pvvx-protocol.md 6.4). Resolves after the end packet was sent.
 *
 * @param session
 * @param image
 * @param length
 * @param options
 */
export async function transferImage(
	session: GattSession,
	image: Buffer,
	length: number,
	options: TransferOptions,
): Promise<void> {
	const blocks = toBlocks(image, length);
	const count = blocks.length;
	const write = (data: Buffer, withResponse: boolean): Promise<void> =>
		session.write(OTA_SERVICE, OTA_CHARACTERISTIC, data, withResponse);

	await write(OTA_CMD_VERSION, OTA_WRITE_WITH_RESPONSE);
	await write(OTA_CMD_START, OTA_WRITE_WITH_RESPONSE);
	await options.sleep(START_DELAY_MS);

	for (let start = 0; start < count; start += PACKETS_PER_STATUS_READ) {
		const end = Math.min(start + PACKETS_PER_STATUS_READ, count);
		const packets: Buffer[] = [];
		for (let index = start; index < end; index++) {
			packets.push(encodeDataPacket(index, blocks[index]));
		}
		// The references read the status after every eighth packet only, not after the last ones
		const full = packets.length === PACKETS_PER_STATUS_READ;
		const status = await session.writeSequence(
			OTA_SERVICE,
			OTA_CHARACTERISTIC,
			packets,
			OTA_WRITE_WITH_RESPONSE,
			full,
		);
		if (full) {
			if (!status || status.length === 0) {
				throw new PvvxUpdateError(
					"UNEXPECTED_ANSWER",
					"Empty update status",
				);
			}
			if (status[0] !== 0) {
				throw new PvvxUpdateError(
					`OTA_STATUS_${status[0]}`,
					otaStatusText(status[0]),
				);
			}
		}
		options.onProgress(end / count);
	}

	try {
		// The device checks the image and restarts: there is no answer, the connection ends
		await write(encodeEndPacket(count - 1), false);
	} catch (e) {
		const code = (e as { code?: unknown })?.code;
		if (code !== "NOT_CONNECTED" && code !== "TIMEOUT") {
			throw e;
		}
	}
	options.onProgress(1);
}
