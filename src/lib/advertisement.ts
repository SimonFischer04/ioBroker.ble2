/**
 * The adapter's own model of a received BLE advertisement.
 * It has the shape the decoder plugins have always worked with (the one `noble` produces),
 * but does not depend on `noble`, so advertisements can come from any source.
 */

export type AddressType = "public" | "random" | "unknown";

/** One service data entry of an advertisement */
export interface ServiceData {
	/** 16 bit UUIDs as 4 lowercase hex chars ("fcd2"), longer UUIDs as lowercase hex without dashes */
	uuid: string;
	/** The data without the UUID */
	data: Buffer;
}

/** The decoded AD structures of an advertisement */
export interface AdvertisementData {
	/** The complete or shortened name of the device */
	localName?: string;
	/** Transmit power in dBm */
	txPowerLevel?: number;
	/** The advertised service UUIDs, in the same form as ServiceData.uuid */
	serviceUuids?: string[];
	/** All service data entries */
	serviceData?: ServiceData[];
	/** The manufacturer specific data including the two leading bytes of the company ID */
	manufacturerData?: Buffer;
	/** All manufacturer blocks, in wire order, when the transport receives raw AD data */
	manufacturerDataBlocks?: Buffer[];
}

/** A received advertisement together with the device that sent it */
export interface PeripheralInfo {
	/** The MAC address without colons */
	id: string;
	/** Same as id, as noble provides it */
	uuid: string;
	/** The MAC address in lowercase with colons, e.g. "a4:c1:38:12:34:56" */
	address: string;
	/** Whether the address is public or random, "unknown" if the source does not say */
	addressType: AddressType;
	/** Whether the device accepts connections, if the source knows */
	connectable?: boolean;
	/** The decoded content of the advertisement */
	advertisement: AdvertisementData;
	/** Signal strength in dBm */
	rssi: number;
	/** Which gateway received this advertisement. Set by the transports. */
	gatewayId?: string;
}

const MAC_REGEX = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;

/**
 * Brings a MAC address into the form the adapter uses for its device IDs (lowercase with colons).
 * Returns undefined if the input is not a MAC address.
 *
 * @param address The address as received, e.g. from a message of another adapter
 */
export function normalizeAddress(address: unknown): string | undefined {
	if (typeof address !== "string") {
		return undefined;
	}
	let ret = address.trim().toLowerCase().replace(/-/g, ":");
	// Also accept addresses without separators
	if (/^[0-9a-f]{12}$/.test(ret)) {
		ret = ret.match(/.{2}/g)!.join(":");
	}
	return MAC_REGEX.test(ret) ? ret : undefined;
}
