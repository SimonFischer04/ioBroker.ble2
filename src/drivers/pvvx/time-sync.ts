import type { PvvxCommandChannel } from "./command-channel";
import {
	clockDeviation,
	encodeConfigRequest,
	encodeTimeRequest,
	localClockValue,
	parseConfigResponse,
	parseTimeResponse,
} from "./protocol";

export interface Clock {
	/** Current time in ms */
	now(): number;
	/** Minutes as Date.prototype.getTimezoneOffset() returns them, for the given time */
	timezoneOffset(atMs: number): number;
}

export const systemClock: Clock = {
	now: () => Date.now(),
	timezoneOffset: (atMs) => new Date(atMs).getTimezoneOffset(),
};

export interface TimeSyncResult {
	version: number;
	hardwareId?: number;
	/** Seconds the device clock was ahead before it was set */
	deviation: number;
	/** The value that was set */
	value: number;
}

/** Thrown when the device does not answer like a pvvx firmware */
export class PvvxProtocolError extends Error {
	public readonly code = "UNEXPECTED_ANSWER";

	public constructor(message: string) {
		super(message);
		this.name = "PvvxProtocolError";
	}
}

/** How far the clock may be off after setting it, in seconds */
const MAX_SET_DEVIATION_S = 2;

/** Reads the configuration and the clock of the device, then sets the clock to the local time */
export async function syncTime(
	channel: PvvxCommandChannel,
	clock: Clock,
): Promise<TimeSyncResult> {
	const config = parseConfigResponse(
		await channel.request(encodeConfigRequest()),
	);
	if (!config) {
		throw new PvvxProtocolError(
			"The device did not answer like a pvvx firmware",
		);
	}

	const before = parseTimeResponse(
		await channel.request(encodeTimeRequest()),
	);
	if (!before) {
		throw new PvvxProtocolError("Invalid answer to reading the time");
	}
	let now = clock.now();
	const deviation = clockDeviation(
		before.clock,
		localClockValue(now, clock.timezoneOffset(now)),
	);

	now = clock.now();
	const value = localClockValue(now, clock.timezoneOffset(now));
	const after = parseTimeResponse(
		await channel.request(encodeTimeRequest(value)),
	);
	if (
		!after ||
		Math.abs(clockDeviation(after.clock, value)) > MAX_SET_DEVIATION_S
	) {
		throw new PvvxProtocolError("The device did not take the time");
	}

	return {
		version: config.version,
		...(config.hardwareId !== undefined
			? { hardwareId: config.hardwareId }
			: {}),
		deviation,
		value,
	};
}
