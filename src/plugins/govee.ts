import type { PeripheralInfo } from "../lib/scanProcessInterface";
import type { Plugin } from "./plugin";

const companyId = 0xec88;
const iBeaconHeader = Buffer.from("4c000215", "hex");

interface ThermometerReading {
	temperature?: number;
	humidity?: number;
	battery?: number;
}

function readThermometer(
	peripheral: PeripheralInfo,
): ThermometerReading | undefined {
	const data = peripheral.advertisement?.manufacturerData;
	if (!data || data.length < 8 || data.readUInt16LE(0) !== companyId) {
		return;
	}

	// Some scanners concatenate the EC88 block with the following Apple iBeacon block.
	if (
		data.length !== 8 &&
		(data.length !== 33 || !data.subarray(8, 12).equals(iBeaconHeader))
	) {
		return;
	}

	const reading: ThermometerReading = {};
	const status = data[6];
	const battery = status & 0x7f;
	if (battery <= 100) {
		reading.battery = battery;
	}

	const packed = data.readUIntBE(3, 3);
	const magnitude = packed & 0x7fffff;
	const temperature = Math.floor(magnitude / 1000) / 10;
	if (!(status & 0x80) && temperature <= (packed & 0x800000 ? 40 : 100)) {
		reading.temperature = packed & 0x800000 ? -temperature : temperature;
		reading.humidity = (magnitude % 1000) / 10;
	}
	return Object.keys(reading).length ? reading : undefined;
}

const stateDefinitions = {
	temperature: { name: "Temperature", role: "value.temperature", unit: "°C" },
	humidity: { name: "Relative humidity", role: "value.humidity", unit: "%" },
	battery: { name: "Battery", role: "value.battery", unit: "%" },
};

const plugin: Plugin<ThermometerReading> = {
	name: "govee",
	description: "Govee H5072 and H5075 thermometers",
	advertisedServices: ["ec88"],
	manufacturerIds: [companyId],
	isHandling: (peripheral) => readThermometer(peripheral) != null,
	createContext: readThermometer,
	defineObjects: (reading) => ({
		device: {},
		channels: undefined,
		states: (Object.keys(reading) as (keyof ThermometerReading)[]).map(
			(id) => ({
				id,
				common: {
					...stateDefinitions[id],
					type: "number",
					read: true,
					write: false,
				},
			}),
		),
	}),
	getValues: (reading) => reading,
};

export = plugin;
