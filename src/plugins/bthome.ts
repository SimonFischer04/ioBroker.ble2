import { Global as _ } from "../lib/global";
import {
	BTHomeAdvertisement,
	type BTHomeBinarySensorData,
	type BTHomeCredentials,
	type BTHomeEvent,
	type BTHomeMultilevelSensorData,
	type SpecialSensors,
} from "./lib/bthome_protocol";
import {
	getServiceData,
	type DeviceObjectDefinition,
	type Plugin,
	type StateObjectDefinition,
} from "./plugin";

interface BTHomeContext {
	readonly packetId?: number;
	readonly multilevelSensors: readonly BTHomeMultilevelSensorData[];
	readonly binarySensors: readonly BTHomeBinarySensorData[];
	readonly specialSensors: readonly SpecialSensors[];
	readonly events: readonly BTHomeEvent[];
}

interface BTHomeDevice extends BTHomeCredentials {
	lastCounter?: number;
}

const devices = new Map<string, BTHomeDevice>();

function normalizeMac(address: string): string {
	return address.trim().replaceAll(":", "").toLowerCase();
}

function loadBindkeys(): void {
	devices.clear();
	let rows: unknown;
	try {
		rows = JSON.parse(_.adapter.config.bthomeBindkeys || "[]");
	} catch {
		_.adapter.log.warn("BTHome: could not read bindkey configuration");
		return;
	}

	if (!Array.isArray(rows)) {
		_.adapter.log.warn("BTHome: expected a list of bindkeys");
		return;
	}

	for (const [index, row] of rows.entries()) {
		const address =
			typeof row?.address === "string" ? row.address.trim() : "";
		const key = typeof row?.key === "string" ? row.key.trim() : "";
		if (
			!/^(?:[\da-f]{12}|(?:[\da-f]{2}:){5}[\da-f]{2})$/i.test(address) ||
			!/^(?:[\da-f]{32}|[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})$/i.test(
				key,
			)
		) {
			_.adapter.log.warn(
				`BTHome: invalid MAC address or bindkey in row ${index + 1}`,
			);
			continue;
		}
		const mac = normalizeMac(address);
		if (devices.has(mac)) {
			_.adapter.log.warn(
				`BTHome: duplicate MAC address in bindkey row ${index + 1}`,
			);
			continue;
		}
		devices.set(mac, {
			mac: Buffer.from(mac, "hex"),
			key: Buffer.from(key.replaceAll("-", ""), "hex"),
		});
	}
}

const plugin: Plugin<BTHomeContext> = {
	name: "BTHome",
	description: "BTHome devices",
	initialize: loadBindkeys,

	advertisedServices: ["fcd2"],
	isHandling: (p) => {
		return !!p.advertisement?.serviceData?.some(
			(entry) => entry.uuid === "fcd2",
		);
	},

	createContext: (peripheral) => {
		const data = getServiceData(peripheral, "fcd2");
		if (data == undefined) {
			return;
		}

		_.adapter.log.debug(`bthome >> got data: ${data.toString("hex")}`);

		const device = devices.get(normalizeMac(peripheral.address ?? ""));
		let advertisement: BTHomeAdvertisement;
		try {
			advertisement = new BTHomeAdvertisement(data, device);
		} catch {
			_.adapter.log.debug(
				`bthome >> failed to parse or authenticate data from ${peripheral.address}`,
			);
			return;
		}

		if (device && advertisement.encryptionCounter !== undefined) {
			if (
				device.lastCounter !== undefined &&
				advertisement.encryptionCounter <= device.lastCounter
			) {
				return;
			}
			device.lastCounter = advertisement.encryptionCounter;
		}

		return {
			packetId: advertisement.packetId,
			multilevelSensors: advertisement.multilevelSensors,
			binarySensors: advertisement.binarySensors,
			specialSensors: advertisement.specialSensors,
			events: advertisement.events,
		};
	},

	defineObjects: (context) => {
		if (context == undefined) {
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

		const duplicates = new Map<string, number>();

		for (const ms of context.multilevelSensors) {
			const id = ms.label
				.toLowerCase()
				.replace(/[()]+/g, "")
				.replace(/ /g, "_");
			const count = duplicates.get(id) ?? 0;
			duplicates.set(id, count + 1);
			const stateId = id + (count > 0 ? `_${count + 1}` : "");
			const stateName = ms.label + (count > 0 ? ` (${count + 1})` : "");

			const stateObject: StateObjectDefinition = {
				id: stateId,
				common: {
					name: stateName,
					read: true,
					write: false,
					type: "number",
					role: "value",
					unit: ms.unit,
				},
				native: undefined,
			};
			stateObjects.push(stateObject);
		}

		for (const bs of context.binarySensors) {
			const id = bs.label.toLowerCase();
			const count = duplicates.get(id) ?? 0;
			duplicates.set(id, count + 1);
			const stateId = id + (count > 0 ? `_${count + 1}` : "");
			const stateName = bs.label + (count > 0 ? ` (${count + 1})` : "");

			const stateObject: StateObjectDefinition = {
				id: stateId,
				common: {
					name: stateName,
					read: true,
					write: false,
					type: "boolean",
					role: "indicator",
					states: bs.states,
				},
				native: undefined,
			};
			stateObjects.push(stateObject);
		}

		for (const ss of context.specialSensors) {
			const id = ss.type.toLowerCase();
			const count = duplicates.get(id) ?? 0;
			duplicates.set(id, count + 1);
			const stateId = id + (count > 0 ? `_${count + 1}` : "");
			const stateName = ss.type + (count > 0 ? ` (${count + 1})` : "");

			if (ss.type === "text" || ss.type === "raw") {
				const stateObject: StateObjectDefinition = {
					id: stateId,
					common: {
						name: stateName,
						read: true,
						write: false,
						type: "string",
						role: "text",
					},
					native: undefined,
				};
				stateObjects.push(stateObject);
			} else if (ss.type === "timestamp") {
				const stateObject: StateObjectDefinition = {
					id: stateId,
					common: {
						name: stateName,
						read: true,
						write: false,
						type: "number",
						role: "value.time",
					},
					native: undefined,
				};
				stateObjects.push(stateObject);
			}
		}

		for (const evt of context.events) {
			const id = evt.type.toLowerCase();
			const count = duplicates.get(id) ?? 0;
			duplicates.set(id, count + 1);
			const stateId = id + (count > 0 ? `_${count + 1}` : "");
			const stateName = evt.type + (count > 0 ? ` (${count + 1})` : "");

			if (evt.type === "button") {
				const stateObject: StateObjectDefinition = {
					id: stateId,
					common: {
						name: stateName,
						read: true,
						write: false,
						type: "string",
						role: "text",
					},
					native: undefined,
				};
				stateObjects.push(stateObject);
			} else if (evt.type === "dimmer") {
				stateObjects.push(
					{
						id: stateId,
						common: {
							name: stateName,
							read: true,
							write: false,
							type: "string",
							role: "text",
						},
						native: undefined,
					},
					{
						id: `${stateId}_steps`,
						common: {
							name: `${stateName} steps`,
							read: true,
							write: false,
							type: "number",
							role: "value",
						},
						native: undefined,
					},
				);
			}
		}

		return ret;
	},

	getValues: (context) => {
		if (context == undefined) {
			return;
		}

		const duplicates = new Map<string, number>();
		const ret: Record<string, any> = {};

		for (const ms of context.multilevelSensors) {
			const id = ms.label
				.toLowerCase()
				.replace(/[()]+/g, "")
				.replace(/ /g, "_");
			const count = duplicates.get(id) ?? 0;
			duplicates.set(id, count + 1);

			const stateId = id + (count > 0 ? `_${count + 1}` : "");
			ret[stateId] = ms.value;
		}

		for (const bs of context.binarySensors) {
			const id = bs.label.toLowerCase();
			const count = duplicates.get(id) ?? 0;
			duplicates.set(id, count + 1);

			const stateId = id + (count > 0 ? `_${count + 1}` : "");
			ret[stateId] = bs.value;
		}

		for (const ss of context.specialSensors) {
			const id = ss.type.toLowerCase();
			const count = duplicates.get(id) ?? 0;
			duplicates.set(id, count + 1);

			const stateId = id + (count > 0 ? `_${count + 1}` : "");
			if (ss.type === "text") {
				ret[stateId] = ss.value;
			} else if (ss.type === "raw") {
				ret[stateId] = ss.value.toString("hex");
			} else if (ss.type === "timestamp") {
				ret[stateId] = ss.value.getTime();
			}
		}

		for (const evt of context.events) {
			const id = evt.type.toLowerCase();
			const count = duplicates.get(id) ?? 0;
			duplicates.set(id, count + 1);
			const stateId = id + (count > 0 ? `_${count + 1}` : "");

			ret[stateId] = evt.event ?? null;
			if (evt.type === "dimmer") {
				ret[`${stateId}_steps`] = evt.event?.steps ?? null;
			}
		}

		return ret;
	},
};

export = plugin as Plugin;
