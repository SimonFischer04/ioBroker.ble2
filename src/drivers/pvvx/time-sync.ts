import type { PvvxCommandChannel } from "./command-channel";
import {
	clockDeviation,
	encodeConfigRequest,
	encodeTimeRequest,
	localClockValue,
	parseConfigResponse,
	parseTimeResponse,
} from "./protocol";

/** Source of the local time, replaceable in tests */
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

/** Outcome of syncTime(), for the states of the device */
export interface TimeSyncResult {
	/** Firmware version byte from the configuration */
	version: number;
	/** Hardware variant from the configuration, if the firmware reports it */
	hardwareId?: number;
	/** Seconds the device clock was ahead before it was set */
	deviation: number;
	/** The value that was set */
	value: number;
}

/** Thrown when the device does not answer like a pvvx firmware */
export class PvvxProtocolError extends Error {
	public readonly code = "UNEXPECTED_ANSWER";

	/**
	 * Creates the error with code UNEXPECTED_ANSWER.
	 *
	 * @param message What was wrong with the answer
	 */
	public constructor(message: string) {
		super(message);
		this.name = "PvvxProtocolError";
	}
}

/** How far the clock may be off after setting it, in seconds */
const MAX_SET_DEVIATION_S = 2;

/**
 * Reads the configuration and the clock of the device, then sets the clock to the local time
 *
 * @param channel Opened command channel to the device
 * @param clock Source of the local time
 */
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
