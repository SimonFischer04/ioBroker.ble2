import { PvvxUpdateError } from "./update-error";

/** README of the pvvx firmware: below this, an update of a LYWSD03MMC is not reliable */
export const MIN_BATTERY_PERCENT = 40;
/** A battery value older than this is not used */
export const MAX_BATTERY_AGE_MS = 3600000;
export const MIN_RSSI = -80;

export interface PreconditionInput {
	/** The device, for the messages */
	address: string;
	now: number;
	/** The state <mac>.battery, undefined if it does not exist */
	battery: { val: unknown; ts: number } | null | undefined;
	/** From ConnectionManager.bestGateway(address, "writeSequence") */
	bestGateway: { gatewayId: string; rssi: number } | undefined;
}

/** Throws PvvxUpdateError if the device must not be updated now */
export function checkPreconditions(input: PreconditionInput): void {
	const { address, now, battery, bestGateway } = input;
	if (!bestGateway) {
		throw new PvvxUpdateError(
			"NO_GATEWAY",
			"No gateway that can update firmware receives the device",
		);
	}
	if (bestGateway.rssi < MIN_RSSI) {
		throw new PvvxUpdateError(
			"WEAK_SIGNAL",
			`${bestGateway.gatewayId} receives the device with ${bestGateway.rssi} dBm, at least ${MIN_RSSI} dBm are needed`,
		);
	}
	if (
		!battery ||
		typeof battery.val !== "number" ||
		now - battery.ts > MAX_BATTERY_AGE_MS
	) {
		throw new PvvxUpdateError(
			"BATTERY_UNKNOWN",
			`No current battery value in ${address}.battery. The device must send its battery level, e.g. in the BTHome format.`,
		);
	}
	if (battery.val < MIN_BATTERY_PERCENT) {
		throw new PvvxUpdateError(
			"BATTERY_LOW",
			`The battery is at ${battery.val} %, at least ${MIN_BATTERY_PERCENT} % are needed`,
		);
	}
}
