// Protocol of the pvvx firmware for Telink thermometers (ATC_MiThermometer), see docs/pvvx-protocol.md.
// Only pure functions, no imports from the adapter.

export const PVVX_SERVICE = "00001f10-0000-1000-8000-00805f9b34fb";
export const PVVX_COMMAND_CHARACTERISTIC =
	"00001f1f-0000-1000-8000-00805f9b34fb";
/** How commands are written. The firmware declares "write without response" only, see docs/pvvx-protocol.md 9.1 */
export const PVVX_WRITE_WITH_RESPONSE = false;

/** Read the configuration */
export const CMD_CONFIG = 0x55;
/** Read or set the clock */
export const CMD_TIME = 0x23;

/** Value for the device clock: local time as Unix seconds, unsigned 32 bit */
export function localClockValue(
	nowMs: number,
	timezoneOffsetMinutes: number,
): number {
	return (Math.floor(nowMs / 1000) - timezoneOffsetMinutes * 60) >>> 0;
}

/** Request to read (no value) or set (value) the clock */
export function encodeTimeRequest(value?: number): Buffer {
	if (value === undefined) return Buffer.from([CMD_TIME]);
	const request = Buffer.alloc(5);
	request[0] = CMD_TIME;
	request.writeUInt32LE(value >>> 0, 1);
	return request;
}

/** Answer to CMD_TIME. undefined if it is not one. */
export function parseTimeResponse(
	data: Buffer,
): { clock: number; lastSet?: number } | undefined {
	if (data.length < 5 || data[0] !== CMD_TIME) return undefined;
	const clock = data.readUInt32LE(1);
	if (data.length >= 9) return { clock, lastSet: data.readUInt32LE(5) };
	return { clock };
}

/** Request to read the configuration: exactly one byte, more bytes would overwrite it */
export function encodeConfigRequest(): Buffer {
	return Buffer.from([CMD_CONFIG]);
}

/** Answer to CMD_CONFIG. undefined if it is not one. */
export function parseConfigResponse(
	data: Buffer,
): { version: number; hardwareId?: number } | undefined {
	if (data.length < 10 || data[0] !== CMD_CONFIG) return undefined;
	const version = data[1];
	if (data.length < 12) return { version };
	let hver = data[11];
	if (version < 0x36) hver &= 0x87;
	if (version >= 0x48) return { version, hardwareId: hver };
	const id = hver & 0x0f;
	return {
		version,
		hardwareId: id === 0x0f ? 16 + (data[10] & 0x7f) : id,
	};
}

/** 0x59 -> "5.9" */
export function formatVersion(version: number): string {
	return `${version >> 4}.${version & 0x0f}`;
}

/** Seconds the device clock is ahead (positive) or behind (negative) */
export function clockDeviation(
	deviceClock: number,
	expectedValue: number,
): number {
	// Difference of two unsigned 32 bit numbers as signed 32 bit number, right across the overflow in 2106
	return (deviceClock - expectedValue) | 0;
}
