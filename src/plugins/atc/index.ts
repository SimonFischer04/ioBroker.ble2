import type { PeripheralInfo } from "../../lib/scanProcessInterface";
import { getServiceData, type Plugin } from "../plugin";
import { startPvvx } from "./pvvx";

const service = "181a";

interface AtcReading {
	temperature: number;
	humidity: number;
	battery: number;
	batteryVoltage: number;
}

function readAtc(peripheral: PeripheralInfo): AtcReading | undefined {
	const data = getServiceData(peripheral, service);
	if (!data || (data.length !== 13 && data.length !== 15)) {
		return;
	}
	const address = peripheral.address?.replace(/[:-]/g, "").toLowerCase();
	if (!address || !/^[0-9a-f]{12}$/.test(address)) {
		return;
	}

	// Only claim a frame from the shared Environmental Sensing UUID if the
	// embedded MAC matches the advertiser. PVVX uses the opposite byte order.
	const custom = data.length === 15;
	const mac = Buffer.from(address, "hex");
	if (custom) {
		mac.reverse();
	}
	if (!data.subarray(0, 6).equals(mac)) {
		return;
	}

	const reading = custom
		? {
				temperature: data.readInt16LE(6) / 100,
				humidity: data.readUInt16LE(8) / 100,
				batteryVoltage: data.readUInt16LE(10) / 1000,
				battery: data[12],
			}
		: {
				temperature: data.readInt16BE(6) / 10,
				humidity: data[8],
				batteryVoltage: data.readUInt16BE(10) / 1000,
				battery: data[9],
			};
	return reading.humidity <= 100 && reading.battery <= 100
		? reading
		: undefined;
}

const stateDefinitions = {
	temperature: { name: "Temperature", role: "value.temperature", unit: "°C" },
	humidity: { name: "Relative humidity", role: "value.humidity", unit: "%" },
	battery: { name: "Battery", role: "value.battery", unit: "%" },
	batteryVoltage: {
		name: "Battery voltage",
		role: "value.voltage",
		unit: "V",
	},
};

const plugin: Plugin<AtcReading> = {
	name: "atc",
	description: "ATC1441 and PVVX custom thermometers",
	advertisedServices: [service],
	isHandling: (peripheral) => readAtc(peripheral) != null,
	createContext: readAtc,
	defineObjects: () => ({
		device: {},
		channels: undefined,
		states: Object.entries(stateDefinitions).map(([id, definition]) => ({
			id,
			common: {
				...definition,
				type: "number",
				read: true,
				write: false,
			},
		})),
	}),
	getValues: (reading) => reading,
	// Thermometers with the pvvx firmware: clock and firmware updates over a gateway
	start: startPvvx,
};

export = plugin;
