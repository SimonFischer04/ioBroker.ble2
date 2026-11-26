// Declares the settings of this plugin
import type {} from "./config";
import { parseDeviceList } from "../../lib/device-list";
import { parseGattRequest } from "../../lib/gatt-request";
import type { PluginContext, PluginInstance } from "../plugin";
import { syncLywsd02Clock } from "./lywsd02-clock";
import { MiFloraBattery } from "./mi-flora-battery";

/**
 * Active part of the plugin "xiaomi": reads the battery of the configured Mi Flora sensors
 * (setting miFloraBatteryDevices) and sets the clock of a LYWSD02 (command syncLywsd02Clock).
 *
 * @param ctx What the core gives the plugins
 * @returns The started Mi Flora battery polling and the LYWSD02 command
 */
export function startXiaomi(ctx: PluginContext): PluginInstance {
	const { adapter, connections } = ctx;

	const plants = parseDeviceList(adapter.config.miFloraBatteryDevices);
	for (const address of plants.invalid) {
		adapter.log.warn(`Ignoring invalid Mi Flora address "${address}"`);
	}
	const battery =
		plants.addresses.length > 0
			? new MiFloraBattery(adapter, connections, plants.addresses)
			: undefined;

	return {
		observe: (peripheral) => battery?.observe(peripheral),
		commands: {
			syncLywsd02Clock: async (message) => {
				const { address } = parseGattRequest(message, {
					characteristic: false,
					data: false,
				});
				const timestamp = await syncLywsd02Clock(connections, address);
				await adapter.setObjectNotExistsAsync(address, {
					type: "device",
					common: { name: address },
					native: { address },
				});
				const id = `${address}.lywsd02LastTimeSync`;
				await adapter.setObjectNotExistsAsync(id, {
					type: "state",
					common: {
						name: "LYWSD02 last time sync",
						type: "number",
						role: "date",
						read: true,
						write: false,
					},
					native: {},
				});
				await adapter.setStateAsync(id, { val: timestamp, ack: true });
				return { timestamp };
			},
		},
		dispose: () => battery?.dispose(),
	};
}
