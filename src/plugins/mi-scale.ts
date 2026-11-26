import type { PeripheralInfo } from "../lib/scanProcessInterface";
import { getServiceData, type Plugin } from "./plugin";

interface ScaleReading {
	weight: number;
	stabilized: boolean;
}

// Xiaomi service-data layouts documented by openScale and xiaomi-ble.
function readScale(peripheral: PeripheralInfo): ScaleReading | undefined {
	const v2 = getServiceData(peripheral, "181b");
	const v1 = getServiceData(peripheral, "181d");
	let rawWeight: number;
	let flags: number;
	let pounds: boolean;
	let jin: boolean;
	if (v2?.length === 13) {
		rawWeight = v2.readUInt16LE(11);
		flags = v2[1];
		pounds = (v2[0] & 0x01) !== 0;
		jin = (flags & 0x40) !== 0;
	} else if (v1?.length === 10) {
		rawWeight = v1.readUInt16LE(1);
		flags = v1[0];
		pounds = (flags & 0x01) !== 0;
		jin = (flags & 0x10) !== 0;
	} else {
		return;
	}

	const removed = (flags & 0x80) !== 0;
	const kilograms =
		(rawWeight / (pounds || jin ? 100 : 200)) *
		(pounds ? 0.45359237 : jin ? 0.5 : 1);
	return {
		weight: removed ? 0 : Math.round(kilograms * 1000) / 1000,
		stabilized: !removed && rawWeight > 0 && (flags & 0x20) !== 0,
	};
}

const plugin: Plugin<ScaleReading> = {
	name: "mi-scale",
	description: "Xiaomi Mi Scale V1 and V2",
	advertisedServices: ["181d", "181b"],
	isHandling: (peripheral) => readScale(peripheral) != null,
	createContext: readScale,
	defineObjects: () => ({
		device: { common: { name: "Xiaomi Mi Scale" } },
		channels: undefined,
		states: [
			{
				id: "weight",
				common: {
					name: "Weight",
					type: "number",
					role: "value",
					unit: "kg",
					read: true,
					write: false,
				},
			},
			{
				id: "stabilized",
				common: {
					name: "Weight stabilized",
					type: "boolean",
					role: "indicator",
					read: true,
					write: false,
				},
			},
		],
	}),
	getValues: (context) => context,
};

export = plugin;
