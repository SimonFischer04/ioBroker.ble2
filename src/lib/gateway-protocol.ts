/**
 * The gateway interface "ble-gateway/1": how other adapters deliver BLE advertisements
 * they received (e.g. from an ESPHome Bluetooth proxy) to this adapter.
 *
 * This file has no dependencies, so adapters that deliver advertisements can copy it.
 *
 *   adapter.sendTo("ble.0", "gateway:advertisements", {
 *       gatewayId: "proxy-og",
 *       items: [{ address: "a4:c1:38:12:34:56", rssi: -67, data: "<base64>" }],
 *   });
 *
 * There is no registration: a gateway is created when its first advertisement arrives.
 * It is identified by the sending instance and the gatewayId, e.g. "esphome.0:proxy-og".
 *
 * Gateways that can open connections to devices announce themselves with "gateway:announce" and
 * report ended connections and notifications with "gateway:connectionState" and "gateway:notification".
 * This adapter then sends the "gatt:*" commands (GattCommands) to the instance that announced the gateway.
 */

export const GATEWAY_PROTOCOL = "ble-gateway/1";

/** The commands this adapter accepts via sendTo */
export const GatewayCommands = {
	/** Delivers a batch of received advertisements */
	advertisements: "gateway:advertisements",
	/** Announces the gateways of an instance and what they can do */
	announce: "gateway:announce",
	/** Reports that a connection ended without being asked to */
	connectionState: "gateway:connectionState",
	/** Delivers a notification of a subscribed characteristic */
	notification: "gateway:notification",
	/** Lists the known gateways */
	getGateways: "getGateways",
	/** Lists the devices that were recently received, with the gateways that see them */
	getDevices: "getDevices",
	/** Lists the services of a device */
	discoverServices: "discoverServices",
	/** Reads a characteristic of a device */
	readCharacteristic: "readCharacteristic",
	/** Writes a characteristic of a device */
	writeCharacteristic: "writeCharacteristic",
} as const;

/** The commands this adapter sends to the instance that announced a gateway */
export const GattCommands = {
	connect: "gatt:connect",
	disconnect: "gatt:disconnect",
	getServices: "gatt:getServices",
	read: "gatt:read",
	write: "gatt:write",
	subscribe: "gatt:subscribe",
	/** Only for gateways with the feature "writeSequence" */
	writeSequence: "gatt:writeSequence",
} as const;

/** Optional commands a gateway can support */
export const GATEWAY_FEATURES = ["writeSequence"] as const;
export type GatewayFeature = (typeof GATEWAY_FEATURES)[number];

/** Most entries in one "gatt:writeSequence" */
export const MAX_WRITE_SEQUENCE_LENGTH = 64;

export interface GatewayAdvertisement {
	/** MAC address of the sending device, e.g. "a4:c1:38:12:34:56". Upper case and "-" are accepted. */
	address: string;
	/** Defaults to "unknown" */
	addressType?: "public" | "random" | "unknown";
	/** Signal strength in dBm */
	rssi: number;
	/**
	 * The raw payload of the advertisement, base64 encoded: the AD structures as they were received,
	 * optionally followed by those of the scan response.
	 */
	data: string;
	connectable?: boolean;
}

/** Payload of "gateway:advertisements" */
export interface GatewayAdvertisementsMessage {
	/** Identifies the gateway within the sending instance. Letters, digits, "_", "-" and ".", up to 64 chars. */
	gatewayId: string;
	/** At most MAX_ADVERTISEMENTS_PER_MESSAGE items */
	items: GatewayAdvertisement[];
}

export const MAX_ADVERTISEMENTS_PER_MESSAGE = 500;

/** Result of "gateway:advertisements" */
export interface GatewayAdvertisementsResult {
	/** How many items were accepted */
	accepted: number;
	/** How many items were skipped because they were invalid */
	rejected: number;
}

/** An entry of the result of "getGateways" */
export interface GatewayInfo {
	/** "local" for the Bluetooth adapter of the host, otherwise "<sender>:<gatewayId>" */
	id: string;
	type: "local" | "server" | "remote";
	/** The instance that delivers the advertisements, e.g. "esphome.0". Only for type "remote". */
	sender?: string;
	connected: boolean;
	/** Timestamp of the last received advertisement */
	lastAdvertisement?: number;
	/** How many advertisements were received since the adapter started */
	advertisements: number;
	/** How many of them were skipped because another gateway delivered the same packet first */
	duplicates: number;
	/** Whether connections to devices can be opened through this gateway */
	connect: boolean;
	/** Free connection slots, if the gateway reported them */
	freeSlots?: number;
	/** Maximum number of connections, if the gateway reported it */
	slotLimit?: number;
	/** Optional commands the gateway supports */
	features: GatewayFeature[];
}

/** An entry of the result of "getDevices" */
export interface DeviceInfo {
	address: string;
	name?: string;
	/** The gateways that recently received the device, strongest signal first */
	gateways: { id: string; rssi: number; lastSeen: number }[];
}

export type GatewayErrorCode =
	| "INVALID_PAYLOAD"
	| "UNSUPPORTED_PROTOCOL"
	| "UNKNOWN_GATEWAY"
	| "NO_FREE_SLOT"
	| "CONNECT_FAILED"
	| "NOT_CONNECTED"
	| "GATT_ERROR"
	| "TIMEOUT"
	| "NO_GATEWAY";

/** All commands of the gateway interface answer with either a result or an error */
export type GatewayResponse<T> =
	| { error: null; result: T }
	| { error: { code: GatewayErrorCode; message: string } };

/** A gateway in "gateway:announce" */
export interface GatewayAnnouncement {
	/** Identifies the gateway within the sending instance, same rules as in "gateway:advertisements" */
	gatewayId: string;
	/** Whether connections to devices can be opened through this gateway */
	connect: boolean;
	/** How many more connections the gateway can open right now. Omit if unknown. */
	freeSlots?: number;
	/** How many connections the gateway can have at the same time. Omit if unknown. */
	slotLimit?: number;
	/** Optional commands the gateway supports, see GATEWAY_FEATURES. Unknown values are ignored. */
	features?: string[];
}

/** Payload of "gateway:announce" */
export interface GatewayAnnounceMessage {
	/** Must be GATEWAY_PROTOCOL */
	protocol: string;
	/** All gateways of the sending instance that are reachable right now, at most 100 */
	gateways: GatewayAnnouncement[];
}

/** Result of "gateway:announce" */
export interface GatewayAnnounceResult {
	protocol: typeof GATEWAY_PROTOCOL;
	/** When this adapter was started (ms since 1970). A new value means it was restarted. */
	epoch: number;
}

/** Identifies a device behind a gateway. gatewayId is the ID within the instance that owns the gateway. */
export interface GattTarget {
	gatewayId: string;
	/** MAC address in lowercase with colons */
	address: string;
}

/** Payload of "gateway:connectionState" */
export interface GatewayConnectionStateMessage extends GattTarget {
	connected: false;
	/** Error code of the gateway, if it reported one */
	error?: number;
}

/** Payload of "gateway:notification" */
export interface GatewayNotificationMessage extends GattTarget {
	/** Handle of the characteristic */
	handle: number;
	/** The value, base64 encoded */
	data: string;
}

/** Payload of "gatt:connect" */
export interface GattConnectRequest extends GattTarget {
	addressType: "public" | "random";
	/** See GatewayAnnounceResult.epoch */
	epoch: number;
}

/** Result of "gatt:connect" */
export interface GattConnectResult {
	/** Negotiated MTU. 23 if the gateway does not report one. */
	mtu: number;
}

export interface GattDescriptorInfo {
	/** 128 bit, lowercase, with dashes */
	uuid: string;
	handle: number;
}

export interface GattCharacteristicInfo {
	/** 128 bit, lowercase, with dashes */
	uuid: string;
	handle: number;
	/** Bit mask: 0x02 read, 0x04 write without response, 0x08 write, 0x10 notify, 0x20 indicate */
	properties: number;
	descriptors: GattDescriptorInfo[];
}

export interface GattServiceInfo {
	/** 128 bit, lowercase, with dashes */
	uuid: string;
	handle: number;
	characteristics: GattCharacteristicInfo[];
}

/** Result of "gatt:getServices" and of "discoverServices" */
export interface GattGetServicesResult {
	services: GattServiceInfo[];
}

/** Payload of "gatt:read" and "gatt:subscribe" */
export interface GattReadRequest extends GattTarget {
	/** Handle of the characteristic */
	handle: number;
}
export type GattSubscribeRequest = GattReadRequest;

/** Result of "gatt:read" and of "readCharacteristic" */
export interface GattReadResult {
	/** The value, base64 encoded */
	data: string;
}

/** Payload of "gatt:write" */
export interface GattWriteRequest extends GattTarget {
	/** Handle of the characteristic */
	handle: number;
	/** The value, base64 encoded */
	data: string;
	/** true = wait for the device to confirm the write */
	withResponse: boolean;
}

/** Payload of "gatt:writeSequence" */
export interface GattWriteSequenceRequest extends GattTarget {
	handle: number;
	/** The values to write, in this order, base64 encoded */
	data: string[];
	withResponse: boolean;
	/** Read the handle after the last write */
	readAfter: boolean;
}

/** Result of "gatt:writeSequence" */
export interface GattWriteSequenceResult {
	/** How many entries were written, always data.length */
	written: number;
	/** The value read after the last write, base64. Only with readAfter. */
	data?: string;
}

/** Payload of "discoverServices" */
export interface DiscoverServicesMessage {
	/** MAC address of the device, upper case and "-" are accepted */
	address: string;
}

/** Payload of "readCharacteristic" */
export interface ReadCharacteristicMessage extends DiscoverServicesMessage {
	/** UUID of the service: "1f10", "0x1f10" or the full UUID with or without dashes */
	service: string;
	/** UUID of the characteristic, same forms */
	characteristic: string;
}

/** Payload of "writeCharacteristic" */
export interface WriteCharacteristicMessage extends ReadCharacteristicMessage {
	/** The value, base64 encoded */
	data: string;
	/** Defaults to true */
	withResponse?: boolean;
}
