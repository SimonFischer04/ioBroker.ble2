import type { PeripheralInfo } from "../lib/scanProcessInterface";
import { getServiceData, type Plugin } from "./plugin";

const urlSchemes = ["http://www.", "https://www.", "http://", "https://"];
const urlExpansions = [
	".com/",
	".org/",
	".edu/",
	".net/",
	".info/",
	".biz/",
	".gov/",
	".com",
	".org",
	".edu",
	".net",
	".info",
	".biz",
	".gov",
];

const stateDefinitions = {
	namespace: { name: "Beacon namespace", type: "string", role: "text" },
	instance: { name: "Beacon instance", type: "string", role: "text" },
	url: { name: "Beacon URL", type: "string", role: "text" },
	ephemeralId: { name: "Ephemeral identifier", type: "string", role: "text" },
	txPower: {
		name: "Calibrated transmit power",
		type: "number",
		role: "value",
		unit: "dBm",
	},
	batteryVoltage: {
		name: "Battery voltage",
		type: "number",
		role: "value.voltage",
		unit: "mV",
	},
	temperature: {
		name: "Temperature",
		type: "number",
		role: "value.temperature",
		unit: "°C",
	},
	advertisementCount: {
		name: "Advertisements since power-on",
		type: "number",
		role: "value",
	},
	uptime: {
		name: "Time since power-on",
		type: "number",
		role: "value",
		unit: "s",
	},
} as const;

type StateId = keyof typeof stateDefinitions;
type EddystoneValues = Partial<Record<StateId, string | number | null>>;

function decodeUrl(data: Buffer): EddystoneValues | undefined {
	const scheme = urlSchemes[data[2]];
	if (scheme == null || data.length < 4 || data.length > 20) {
		return;
	}
	let url = scheme;
	for (const byte of data.subarray(3)) {
		const expansion = urlExpansions[byte];
		if (expansion != null) {
			url += expansion;
		} else if (byte >= 0x21 && byte <= 0x7e) {
			url += String.fromCharCode(byte);
		} else {
			return;
		}
	}
	return { url, txPower: data.readInt8(1) };
}

// Eddystone service-data frames are defined at github.com/google/eddystone.
function decodeFrame(peripheral: PeripheralInfo): EddystoneValues | undefined {
	const data = getServiceData(peripheral, "feaa");
	if (!data) {
		return;
	}
	switch (data[0]) {
		case 0x00: // UID, with or without the two reserved bytes
			if (data.length === 18 || data.length === 20) {
				return {
					namespace: data.subarray(2, 12).toString("hex"),
					instance: data.subarray(12, 18).toString("hex"),
					txPower: data.readInt8(1),
				};
			}
			return;
		case 0x10:
			return decodeUrl(data);
		case 0x20: // Unencrypted telemetry
			if (data.length === 14 && data[1] === 0) {
				const voltage = data.readUInt16BE(2);
				const temperature = data.readInt16BE(4);
				return {
					batteryVoltage: voltage === 0 ? null : voltage,
					temperature:
						temperature === -32768 ? null : temperature / 256,
					advertisementCount: data.readUInt32BE(6),
					uptime: data.readUInt32BE(10) / 10,
				};
			}
			return;
		case 0x30:
			if (data.length === 10) {
				return {
					ephemeralId: data.subarray(2).toString("hex"),
					txPower: data.readInt8(1),
				};
			}
	}
}

const plugin: Plugin<EddystoneValues> = {
	name: "eddystone",
	description: "Eddystone beacons",
	advertisedServices: ["feaa"],
	isHandling: (peripheral) => decodeFrame(peripheral) != null,
	createContext: decodeFrame,
	defineObjects: (context) => ({
		device: { common: { name: "Eddystone beacon" } },
		channels: undefined,
		states: (Object.keys(context) as StateId[]).map((id) => ({
			id,
			common: { ...stateDefinitions[id], read: true, write: false },
		})),
	}),
	getValues: (context) => context,
};

export = plugin;
