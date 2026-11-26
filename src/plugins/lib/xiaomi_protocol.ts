import { createDecipheriv } from "node:crypto";

const enum FrameControlFlags {
	NewFactory = 1 << 0,
	Connected = 1 << 1,
	Central = 1 << 2,
	Encrypted = 1 << 3,
	MacAddress = 1 << 4,
	Capabilities = 1 << 5,
	Event = 1 << 6,
	CustomData = 1 << 7,
	Subtitle = 1 << 8,
	Binding = 1 << 9,
}

export enum CapabilityFlags {
	Connectable = 1 << 0,
	Central = 1 << 1,
	Encrypt = 1 << 2,
	IO = (1 << 3) | (1 << 4),
}

export enum XiaomiEventIDs_Internal {
	Temperature = 0x1004, // temp = value / 10
	KettleStatusAndTemperature = 0x1005, // 1 byte status, 1 byte temperature
	Humidity = 0x1006, // humidity = value / 10
	Illuminance = 0x1007,
	Moisture = 0x1008,
	Fertility = 0x1009,
	Battery = 0x100a,
	TemperatureAndHumidity = 0x100d, // 2 byte temperature / 10, 2 byte humidity / 10
	PowerState = 0x1012, // 0 = off, 1 = on
	ConsumableRemaining = 0x1013, // remaining amount in percent
}

export type XiaomiEventIDs =
	| "temperature"
	| "humidity"
	| "illuminance"
	| "moisture"
	| "fertility"
	| "battery"
	| "kettleStatus"
	| "powerState"
	| "consumableRemaining";

export type XiaomiEvent = Partial<Record<XiaomiEventIDs, number>>;
type ValueTransform = (
	val: number,
	eventID?: XiaomiEventIDs_Internal,
) => XiaomiEvent;

// value transforms translate the internal data structure to the external one
// in most cases this is a 1:1 match
const valueTransforms: Partial<
	Record<keyof typeof XiaomiEventIDs_Internal, ValueTransform>
> & { default: ValueTransform } = {
	// by default just pass the value through
	default: (val, eventID) => {
		if (eventID! in XiaomiEventIDs_Internal) {
			return { [XiaomiEventIDs_Internal[eventID!].toLowerCase()]: val };
		}
		return { [`unknown (0x${eventID!.toString(16)})`]: val };
	},
	// TODO: find a nicer way to specify the bit size of temperature - this information exists in the packet!
	Temperature: (val) => ({ temperature: toSigned(val, 16) / 10 }),
	Humidity: (val) => ({ humidity: val / 10 }),
	// Faulty sensor readings must not overwrite the last valid soil moisture.
	Moisture: (val) => (val >= 0 && val <= 100 ? { moisture: val } : {}),
	TemperatureAndHumidity: (val) => ({
		// the data is read in little-endian (reverse) order,
		// so val = 0xHHHHTTTT
		humidity: (val >>> 16) / 10,
		temperature: toSigned(val & 0xffff, 16) / 10,
	}),
	KettleStatusAndTemperature: (val) => ({
		// the data is read in little-endian (reverse) order, so val = 0xTTSS
		kettleStatus: val & 0xff,
		temperature: val >>> 8,
	}),
	PowerState: (val) => ({ powerState: val }),
	ConsumableRemaining: (val) => ({ consumableRemaining: val }),
};

export class XiaomiAdvertisement {
	public constructor(
		data: Buffer,
		advertisedAddress?: string,
		findBindkey?: (mac: string) => Buffer | undefined,
	) {
		if (!data || data.length < 5) {
			throw new Error(
				"A xiaomi advertisement frame must be at least 5 bytes long",
			);
		}
		// 4 bit version, 12 bit flags
		const frameControl = data.readUInt16LE(0);
		this._version = frameControl >>> 12;
		const flags = frameControl & 0xfff;
		this._isNewFactory = (flags & FrameControlFlags.NewFactory) !== 0;
		this._isConnected = (flags & FrameControlFlags.Connected) !== 0;
		this._isCentral = (flags & FrameControlFlags.Central) !== 0;
		this._isEncrypted = (flags & FrameControlFlags.Encrypted) !== 0;
		this._hasMacAddress = (flags & FrameControlFlags.MacAddress) !== 0;
		this._hasCapabilities = (flags & FrameControlFlags.Capabilities) !== 0;
		this._hasEvent = (flags & FrameControlFlags.Event) !== 0;
		this._hasCustomData = (flags & FrameControlFlags.CustomData) !== 0;
		this._hasSubtitle = (flags & FrameControlFlags.Subtitle) !== 0;
		this._isBindingFrame = (flags & FrameControlFlags.Binding) !== 0;

		this._productID = data.readUInt16LE(2);

		this._frameCounter = data[4];

		// The actual packet content begins at offset 5
		let offset = 5;
		if (this._hasMacAddress) {
			if (data.length < offset + 6) {
				throw new Error("Truncated MiBeacon MAC address");
			}
			this._macAddress = reverseBuffer(
				data.slice(offset, offset + 6),
			).toString("hex");
			offset += 6;
		}

		if (this._hasCapabilities) {
			if (data.length <= offset) {
				throw new Error("Truncated MiBeacon capabilities");
			}
			this._capabilities = data[offset++];
			if ((this._capabilities & 0x20) !== 0) {
				if (data.length <= offset) {
					throw new Error("Truncated MiBeacon I/O capabilities");
				}
				offset++;
			}
		}

		if (!this._hasEvent) {
			return;
		}
		if (!this._isEncrypted) {
			this._event = readEvent(data, offset).event;
			return;
		}
		if (this._version !== 4 && this._version !== 5) {
			throw new Error("Unsupported encrypted MiBeacon version");
		}

		const address = advertisedAddress?.replace(/[:-]/g, "").toLowerCase();
		const validAddress =
			address != null && /^[0-9a-f]{12}$/.test(address)
				? address
				: undefined;
		const mac = this._macAddress ?? validAddress;
		if (
			mac == undefined ||
			!/^[0-9a-f]{12}$/.test(mac) ||
			(validAddress && validAddress !== mac)
		) {
			throw new Error("Invalid MAC address for encrypted MiBeacon");
		}
		const key = findBindkey?.(mac);
		if (key?.length !== 16) {
			throw new Error("No valid MiBeacon bindkey is configured");
		}
		const payload = decryptEvents(data, offset, mac, key);
		const events: XiaomiEvent = {};
		for (let cursor = 0; cursor < payload.length;) {
			const { event, end } = readEvent(payload, cursor);
			Object.assign(events, event);
			cursor = end;
		}
		this._event = events;
	}

	private _productID: number;
	public get productID(): number {
		return this._productID;
	}

	private _version: number;
	public get version(): number {
		return this._version;
	}

	private _frameCounter: number;
	public get frameCounter(): number {
		return this._frameCounter;
	}

	private _isNewFactory: boolean;
	public get isNewFactory(): boolean {
		return this._isNewFactory;
	}

	private _isConnected: boolean;
	public get isConnected(): boolean {
		return this._isConnected;
	}

	private _isCentral: boolean;
	public get isCentral(): boolean {
		return this._isCentral;
	}

	private _isEncrypted: boolean;
	public get isEncrypted(): boolean {
		return this._isEncrypted;
	}

	private _hasMacAddress: boolean;
	public get hasMacAddress(): boolean {
		return this._hasMacAddress;
	}

	private _macAddress: string | undefined;
	public get macAddress(): string | undefined {
		return this._macAddress;
	}

	private _hasCapabilities: boolean;
	public get hasCapabilities(): boolean {
		return this._hasCapabilities;
	}

	private _capabilities: number | undefined;
	public get capabilities(): number | undefined {
		return this._capabilities;
	}

	private _hasEvent: boolean;
	public get hasEvent(): boolean {
		return this._hasEvent;
	}

	private _event: XiaomiEvent | undefined;
	public get event(): XiaomiEvent | undefined {
		return this._event;
	}

	private _hasCustomData: boolean;
	public get hasCustomData(): boolean {
		return this._hasCustomData;
	}

	private _customData: Buffer | undefined;
	public get customData(): Buffer | undefined {
		return this._customData;
	}

	private _hasSubtitle: boolean;
	public get hasSubtitle(): boolean {
		return this._hasSubtitle;
	}

	private _isBindingFrame: boolean;
	public get isBindingFrame(): boolean {
		return this._isBindingFrame;
	}
}

function readEvent(
	data: Buffer,
	offset: number,
): { event: XiaomiEvent; end: number } {
	if (offset + 3 > data.length) {
		throw new Error("Truncated MiBeacon event header");
	}
	const id = data.readUInt16LE(offset) as XiaomiEventIDs_Internal;
	const end = offset + 3 + data[offset + 2];
	if (end > data.length) {
		throw new Error("Truncated MiBeacon event");
	}
	const value = parseNumberLE(data.subarray(offset + 3, end));
	const name = XiaomiEventIDs_Internal[
		id
	] as keyof typeof XiaomiEventIDs_Internal;
	return {
		event: (valueTransforms[name] ?? valueTransforms.default)(value, id),
		end,
	};
}

// MiBeacon v4/v5 uses the reversed MAC, product and frame counter, then three extension bytes.
function decryptEvents(
	data: Buffer,
	offset: number,
	mac: string,
	key: Buffer,
): Buffer {
	if (data.length < offset + 10) {
		throw new Error("Truncated encrypted MiBeacon advertisement");
	}
	const nonce = Buffer.concat([
		Buffer.from(mac, "hex").reverse(),
		data.subarray(2, 5),
		data.subarray(-7, -4),
	]);
	const ciphertext = data.subarray(offset, -7);
	const decoder = createDecipheriv("aes-128-ccm", key, nonce, {
		authTagLength: 4,
	});
	decoder.setAuthTag(data.subarray(-4));
	decoder.setAAD(Buffer.from([0x11]), { plaintextLength: ciphertext.length });
	return Buffer.concat([decoder.update(ciphertext), decoder.final()]);
}

function reverseBuffer(buf: Buffer): Buffer {
	const ret = Buffer.allocUnsafe(buf.length);
	for (let i = 0; i < buf.length; i++) {
		ret[i] = buf[buf.length - 1 - i];
	}
	return ret;
}

function parseNumberLE(
	buf: Buffer,
	offset: number = 0,
	length: number = buf.length,
): number {
	// read <length> bytes in LE order
	let value = 0;
	for (let i = offset + length - 1; i >= offset; i--) {
		value = (value << 8) + buf[i];
	}
	return value;
}

/**
 * Converts an unsigned number to a signed one (e.g. 0xffff = 65535 -> -1)
 *
 * @param unsigned Unsigned integer value
 * @param size Number of bits in the encoded value
 */
function toSigned(unsigned: number, size: number): number {
	if (unsigned >>> (size - 1) === 1) {
		// if the first bit is 1, we have a negative number
		return unsigned - (1 << size);
	}
	return unsigned;
}
