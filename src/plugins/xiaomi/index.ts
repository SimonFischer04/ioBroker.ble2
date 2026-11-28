/*!
 * Plugin for Xiaomi devices using the fe95 characteristic
 */

import { entries } from "alcalzone-shared/objects";
import type {} from "../../lib/adapter-config";
import { Global as _ } from "../../lib/global";
import type { PeripheralInfo } from "../../lib/scanProcessInterface";
import { XiaomiAdvertisement, type XiaomiEvent } from "../lib/xiaomi_protocol";
import { startXiaomi } from "./active";
import {
	getServiceData,
	type DeviceObjectDefinition,
	type Plugin,
	type StateObjectDefinition,
} from "../plugin";

interface XiaomiContext {
	event?: XiaomiEvent;
}

let loadedBindkeyConfig: string | undefined;
const bindkeys = new Map<string, Buffer>();

function findBindkey(mac: string): Buffer | undefined {
	const config = _.adapter.config.xiaomiBindkeys;
	if (config !== loadedBindkeyConfig) {
		loadedBindkeyConfig = config;
		bindkeys.clear();
		try {
			const rows: unknown = JSON.parse(config || "[]");
			if (Array.isArray(rows)) {
				for (const row of rows) {
					if (
						typeof row?.address !== "string" ||
						typeof row?.key !== "string"
					) {
						continue;
					}
					const address = row.address
						.trim()
						.replace(/[:-]/g, "")
						.toLowerCase();
					const key = row.key.trim();
					if (
						/^[0-9a-f]{12}$/.test(address) &&
						/^(?:[0-9a-f]{24}|[0-9a-f]{32})$/i.test(key)
					) {
						bindkeys.set(address, Buffer.from(key, "hex"));
					}
				}
			}
		} catch {
			_.adapter.log.warn("Xiaomi bindkey configuration is invalid.");
		}
	}
	return bindkeys.get(mac);
}

function parseAdvertisementEvent(
	data: Buffer,
	address: string,
): XiaomiEvent | undefined {
	// try to parse the data
	let advertisement: XiaomiAdvertisement;
	try {
		advertisement = new XiaomiAdvertisement(data, address, findBindkey);
	} catch {
		_.adapter.log.debug(`xiaomi >> failed to parse data`);
		return;
	}

	if (!advertisement.hasEvent || advertisement.isBindingFrame) {
		_.adapter.log.debug(`xiaomi >> The device is not fully initialized.`);
		_.adapter.log.debug(
			`xiaomi >> Use its app to complete the initialization.`,
		);
		return;
	}

	// succesful - return it
	return advertisement.event;
}

// Remember devices that sent a valid event for 1h.
const testValidity = 1000 * 3600;
const recognizedPeripherals = new Map<string, number>();

const plugin: Plugin<XiaomiContext> = {
	name: "Xiaomi",
	description: "Xiaomi devices",

	advertisedServices: ["fe95"],
	isHandling: (p) => {
		const data = getServiceData(p, "fe95");
		if (data == undefined) {
			return false;
		}

		const mac = p.address.toLowerCase();
		const cached = recognizedPeripherals.get(mac);
		if (cached != undefined && cached >= Date.now() - testValidity) {
			return true;
		}

		// A status or incomplete frame can precede an event from the same device.
		if (parseAdvertisementEvent(data, p.address) == undefined) {
			recognizedPeripherals.delete(mac);
			return false;
		}
		recognizedPeripherals.set(mac, Date.now());
		return true;
	},

	createContext: (peripheral: PeripheralInfo) => {
		const data = getServiceData(peripheral, "fe95");
		if (data == undefined) {
			return;
		}

		_.adapter.log.debug(`xiaomi >> got data: ${data.toString("hex")}`);

		const event = parseAdvertisementEvent(data, peripheral.address);
		if (event == undefined) {
			return;
		}

		return { event };
	},

	defineObjects: (context: XiaomiContext) => {
		if (context == undefined || context.event == undefined) {
			return;
		}

		const deviceObject: DeviceObjectDefinition = {
			// no special definitions neccessary
			common: undefined,
			native: undefined,
		};

		// no channels

		const stateObjects: StateObjectDefinition[] = [];

		const ret = {
			device: deviceObject,
			channels: undefined,
			states: stateObjects,
		};

		const event = context.event;
		if ("temperature" in event) {
			stateObjects.push({
				id: "temperature",
				common: {
					role: "value",
					name: "Temperature",
					type: "number",
					unit: "°C",
					read: true,
					write: false,
				},
				native: undefined,
			});
		}
		if ("humidity" in event) {
			stateObjects.push({
				id: "humidity",
				common: {
					role: "value",
					name: "Relative Humidity",
					type: "number",
					unit: "%rF",
					read: true,
					write: false,
				},
				native: undefined,
			});
		}
		if ("illuminance" in event) {
			stateObjects.push({
				id: "illuminance",
				common: {
					role: "value",
					name: "Illuminance",
					type: "number",
					unit: "lux",
					read: true,
					write: false,
				},
				native: undefined,
			});
		}
		if ("moisture" in event) {
			stateObjects.push({
				id: "moisture",
				common: {
					role: "value",
					name: "Moisture",
					desc: "Moisture of the soil",
					type: "number",
					unit: "%",
					read: true,
					write: false,
				},
				native: undefined,
			});
		}
		if ("fertility" in event) {
			stateObjects.push({
				id: "fertility",
				common: {
					role: "value",
					name: "Fertility",
					desc: "Fertility of the soil",
					type: "number",
					unit: "µS/cm",
					read: true,
					write: false,
				},
				native: undefined,
			});
		}
		if ("battery" in event) {
			stateObjects.push({
				id: "battery",
				common: {
					role: "value",
					name: "Battery",
					desc: "Battery status of the sensor",
					type: "number",
					unit: "%",
					read: true,
					write: false,
				},
				native: undefined,
			});
		}
		if ("kettleStatus" in event) {
			stateObjects.push({
				id: "kettleStatus",
				common: {
					role: "value",
					name: "Kettle status",
					desc: "What the kettle is currently doing",
					type: "number",
					read: true,
					write: false,
					states: {
						0: "Idle",
						1: "Heating",
						2: "Cooling",
						3: "Keeping warm",
					},
				},
				native: undefined,
			});
		}
		if ("powerState" in event) {
			stateObjects.push({
				id: "powerState",
				common: {
					role: "value",
					name: "Power status",
					type: "number",
					read: true,
					write: false,
					states: { 0: "Off", 1: "On" },
				},
				native: undefined,
			});
		}
		if ("consumableRemaining" in event) {
			stateObjects.push({
				id: "consumableRemaining",
				common: {
					role: "value",
					name: "Consumable remaining",
					type: "number",
					unit: "%",
					read: true,
					write: false,
				},
				native: undefined,
			});
		}
		// Create objects for unknown events
		for (const [id, role, name] of [
			["contactOpen", "sensor.door", "Door or window open"],
			["doorLeftOpen", "indicator.alarm", "Door or window left open"],
		] as const) {
			if (id in event) {
				stateObjects.push({
					id,
					common: {
						role,
						name,
						type: "boolean",
						read: true,
						write: false,
					},
				});
			}
		}

		for (const key of Object.keys(event)) {
			if (key.startsWith("unknown ")) {
				stateObjects.push({
					id: key.replace(/[()]+/g, "").replace(" ", "_"),
					common: {
						role: "value",
						name: key,
						type: "number",
						read: true,
						write: false,
					},
					native: undefined,
				});
			}
		}

		return ret;
	},
	getValues: (context: XiaomiContext) => {
		if (context == null || context.event == null) {
			return;
		}

		for (const [prop, value] of entries(context.event)) {
			_.adapter.log.debug(`xiaomi >> got ${prop} update => ${value}`);
		}
		// The event is simply the value dictionary itself
		return context.event;
	},
	// Mi Flora battery and LYWSD02 clock over a gateway
	start: startXiaomi,
};

export = plugin as Plugin;
