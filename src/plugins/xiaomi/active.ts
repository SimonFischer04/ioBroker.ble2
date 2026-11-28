// Declares the settings of this plugin
import type {} from "./config";
import type { SessionOptions } from "../../connections/connection-manager";
import { DevicePoller } from "../../connections/device-poller";
import { readDeviceList } from "../../lib/device-list";
import { parseDeviceRequest } from "../../lib/gatt-request";
import type { PluginContext, PluginInstance } from "../plugin";
import { syncLywsd02Clock } from "./lywsd02-clock";
import { MiFloraBattery } from "./mi-flora-battery";

/**
 * Active part of the plugin "xiaomi": reads the battery of the configured Mi Flora sensors
 * (setting miFloraBatteryDevices) and synchronizes LYWSD02 clocks automatically or on request.
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

	const clockPoller = new DevicePoller(
		adapter.log,
		connections,
		readDeviceList(
			adapter,
			adapter.config.lywsd02ClockDevices,
			"LYWSD02 clock",
		),
		{
			intervalMs: 24 * 60 * 60_000,
			retryMs: 15 * 60_000,
			what: "set the clock of",
		},
		async (address) => {
			await setClockAndRecord(address);
		},
	);

	async function setClockAndRecord(
		address: string,
		options?: SessionOptions,
	): Promise<number> {
		const timestamp = await syncLywsd02Clock(connections, address, options);
		if (clockPoller.disposed) {
			return timestamp;
		}
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
		if (!clockPoller.disposed) {
			await adapter.setStateAsync(id, { val: timestamp, ack: true });
		}
		return timestamp;
	}

	return {
		observe: (peripheral) => {
			battery.observe(peripheral);
			clockPoller.observe(peripheral);
		},
		commands: {
			syncLywsd02Clock: async (message) => {
				const { address, options } = parseDeviceRequest(message);
				return { timestamp: await setClockAndRecord(address, options) };
			},
		},
		dispose: () => {
			battery.dispose();
			clockPoller.dispose();
		},
	};
}
