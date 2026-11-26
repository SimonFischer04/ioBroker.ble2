// Firmware update of the Telink chips the pvvx firmware runs on (Telink OTA), see docs/pvvx-protocol.md 6.
// Only pure functions, no imports from the adapter.

export const OTA_SERVICE = "00010203-0405-0607-0809-0a0b0c0d1912";
export const OTA_CHARACTERISTIC = "00010203-0405-0607-0809-0a0b0c0d2b12";
/** How data packets are written, see docs/spec-phase-4-pvvx-ota.md section 0, H1 */
export const OTA_WRITE_WITH_RESPONSE = false;
/** The status is read after this many data packets, see section 0, H2 */
export const PACKETS_PER_STATUS_READ = 8;
/** Largest image without the extended update */
export const MAX_IMAGE_SIZE = 0x20000;
const MIN_IMAGE_SIZE = 1024;
export const OTA_CMD_VERSION = Buffer.from([0x00, 0xff]);
export const OTA_CMD_START = Buffer.from([0x01, 0xff]);

const BLOCK_SIZE = 16;
const SIGNATURE = Buffer.from("KNLT", "ascii");
const ZIGBEE_MAGIC = Buffer.from([0x1e, 0xf1, 0xee, 0x0b]);

/**
 * CRC-16/MODBUS: start 0xFFFF, reflected polynomial 0xA001, no final XOR
 *
 * @param data Bytes to check
 */
export function crc16Modbus(data: Uint8Array): number {
	let crc = 0xffff;
	for (const byte of data) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) {
			crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
		}
	}
	return crc;
}

const CRC32_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let bit = 0; bit < 8; bit++) {
			c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
		}
		table[n] = c >>> 0;
	}
	return table;
})();

/**
 * CRC-32 of the Telink images: polynomial 0xEDB88320, start 0xFFFFFFFF, no final XOR
 *
 * @param data Bytes to check
 */
export function crc32Telink(data: Uint8Array): number {
	// Own table: zlib.crc32 only exists from Node.js 20.15
	let crc = 0xffffffff;
	for (const byte of data) {
		crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	}
	return crc >>> 0;
}

export type ImageProblem =
	| "TOO_SMALL"
	| "TOO_LARGE"
	| "ZIGBEE"
	| "NO_SIGNATURE"
	| "BAD_LENGTH"
	| "BAD_CHECKSUM";

/**
 * Checks an image as in docs/pvvx-protocol.md 6.2. Returns the length n of the image or the problem.
 *
 * @param image Content of the firmware file
 */
export function validateImage(
	image: Buffer,
): { length: number } | { problem: ImageProblem } {
	if (image.length < MIN_IMAGE_SIZE) {
		return { problem: "TOO_SMALL" };
	}
	if (image.length > MAX_IMAGE_SIZE) {
		return { problem: "TOO_LARGE" };
	}
	if (image.subarray(0, 4).equals(ZIGBEE_MAGIC)) {
		return { problem: "ZIGBEE" };
	}
	if (!image.subarray(8, 12).equals(SIGNATURE)) {
		return { problem: "NO_SIGNATURE" };
	}
	const length = image.readUInt32LE(0x18);
	if (
		length > image.length ||
		length < MIN_IMAGE_SIZE ||
		(length & 0x0f) !== 4
	) {
		return { problem: "BAD_LENGTH" };
	}
	if (
		image.readUInt32LE(length - 4) !==
		crc32Telink(image.subarray(0, length - 4))
	) {
		return { problem: "BAD_CHECKSUM" };
	}
	return { length };
}

/**
 * The first n bytes of the image, padded with 0xFF to a multiple of 16, as blocks of 16 bytes
 *
 * @param image Firmware image
 * @param length Length n from validateImage()
 */
export function toBlocks(image: Buffer, length: number): Buffer[] {
	const count = Math.ceil(length / BLOCK_SIZE);
	const padded = Buffer.alloc(count * BLOCK_SIZE, 0xff);
	image.copy(padded, 0, 0, length);
	const blocks: Buffer[] = [];
	for (let i = 0; i < count; i++) {
		blocks.push(padded.subarray(i * BLOCK_SIZE, (i + 1) * BLOCK_SIZE));
	}
	return blocks;
}

/**
 * Data packet: index (2 bytes LE), 16 bytes, CRC-16 over both (2 bytes LE)
 *
 * @param index Number of the block, from 0
 * @param block 16 bytes of the image
 */
export function encodeDataPacket(index: number, block: Buffer): Buffer {
	const packet = Buffer.alloc(2 + BLOCK_SIZE + 2);
	packet.writeUInt16LE(index, 0);
	block.copy(packet, 2, 0, BLOCK_SIZE);
	packet.writeUInt16LE(crc16Modbus(packet.subarray(0, 18)), 18);
	return packet;
}

/**
 * End packet: 02 ff, last index (LE), last index inverted (LE)
 *
 * @param lastIndex Index of the last data packet
 */
export function encodeEndPacket(lastIndex: number): Buffer {
	const packet = Buffer.from([0x02, 0xff, 0, 0, 0, 0]);
	packet.writeUInt16LE(lastIndex, 2);
	packet.writeUInt16LE(~lastIndex & 0xffff, 4);
	return packet;
}

/**
 * Text for a status byte of the update, docs/pvvx-protocol.md 6.6
 *
 * @param status Status byte reported by the device
 */
export function otaStatusText(status: number): string {
	switch (status) {
		case 1:
			return "packets lost";
		case 2:
			return "packet CRC error";
		case 3:
			return "flash write error";
		case 4:
			return "last packets missing";
		case 5:
			return "timeout";
		case 6:
			return "image check failed";
		default:
			return `unknown status ${status}`;
	}
}
