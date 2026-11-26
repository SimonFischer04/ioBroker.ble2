import type { PeripheralInfo } from "../../lib/scanProcessInterface";
import { getServiceData, type Plugin } from "../plugin";

const serviceIds = ["fd3d", "0d00"];
const meterTypes = new Set(["t", "i", "w", "4", "5"]);
const switchBotCompanyId = 0x0969;

interface MeterReading {
	temperature?: number;
	humidity?: number;
	battery?: number;
}

function readMeter(peripheral: PeripheralInfo): MeterReading | undefined {
	const service =
		getServiceData(peripheral, "fd3d") ??
		getServiceData(peripheral, "0d00");
	if (
		!service ||
		service.length < 3 ||
		!meterTypes.has(String.fromCharCode(service[0] & 0x7f).toLowerCase())
	) {
		return;
	}

	const reading: MeterReading = {};
	const battery = service[2] & 0x7f;
	if (battery <= 100) {
		reading.battery = battery;
	}

	// The manufacturer layout starts after Noble's two-byte company ID.
	const manufacturer = peripheral.advertisement.manufacturerData;
	const data =
		manufacturer &&
		manufacturer.length >= 13 &&
		manufacturer.readUInt16LE(0) === switchBotCompanyId
			? manufacturer.subarray(10, 13)
			: service.subarray(3, 6);
	if (data.length === 3) {
		const tenths = data[0] & 0x0f;
		const humidity = data[2] & 0x7f;
		if (tenths <= 9 && humidity <= 100) {
			const degrees = (data[1] & 0x7f) + tenths / 10;
			reading.temperature = (data[1] & 0x80) !== 0 ? degrees : -degrees;
			reading.humidity = humidity;
		}
	}
	return Object.keys(reading).length ? reading : undefined;
}

const stateDefinitions = {
	temperature: { name: "Temperature", role: "value.temperature", unit: "°C" },
	humidity: { name: "Relative humidity", role: "value.humidity", unit: "%" },
	battery: { name: "Battery", role: "value.battery", unit: "%" },
};

const plugin: Plugin<MeterReading> = {
	name: "switchbot",
	description: "SwitchBot Meter family",
	advertisedServices: serviceIds,
	isHandling: (peripheral) => readMeter(peripheral) != null,
	createContext: readMeter,
	defineObjects: (context) => ({
		device: { common: { name: "SwitchBot Meter" } },
		channels: undefined,
		states: (Object.keys(context) as (keyof MeterReading)[]).map((id) => ({
			id,
			common: {
				...stateDefinitions[id],
				type: "number",
				read: true,
				write: false,
			},
		})),
	}),
	getValues: (context) => context,
};

export = plugin;
