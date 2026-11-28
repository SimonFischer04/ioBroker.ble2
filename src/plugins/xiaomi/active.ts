// Declares the settings of this plugin
import type {} from "./config";
import { readDeviceList } from "../../lib/device-list";
import { parseDeviceRequest } from "../../lib/gatt-request";
import type { PluginContext, PluginInstance } from "../plugin";
import { readKettleProStatus } from "./kettle-pro";
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

	const battery = new MiFloraBattery(
		adapter,
		connections,
		readDeviceList(
			adapter,
			adapter.config.miFloraBatteryDevices,
			"Mi Flora sensor",
		),
	);

	return {
		observe: (peripheral) => battery.observe(peripheral),
		commands: {
			readXiaomiKettlePro: async (message) => {
				const { address, options } = parseDeviceRequest(message);
				const { token } = message as { token?: unknown };
				return readKettleProStatus(
					connections,
					address,
					token,
					options,
				);
			},
			syncLywsd02Clock: async (message) => {
				const { address, options } = parseDeviceRequest(message);
				const timestamp = await syncLywsd02Clock(
					connections,
					address,
					options,
				);
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
		dispose: () => battery.dispose(),
	};
}
