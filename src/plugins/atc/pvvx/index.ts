// Declares the settings of this plugin
import type {} from "./config";
import { parseDeviceList } from "../../../lib/device-list";
import type { PluginContext, PluginInstance } from "../../plugin";
import {
	createHttpFirmwareSource,
	DEFAULT_FIRMWARE_URL,
	FirmwareCatalog,
} from "./firmware-catalog";
import { PvvxDriver } from "./pvvx-driver";
import { PvvxUpdater } from "./pvvx-updater";
import { systemClock } from "./time-sync";

/**
 * Active part of the plugin "atc" for the pvvx firmware: sets the clock of the configured
 * thermometers and installs newer firmware (settings pvvxDevices, pvvxSyncInterval,
 * pvvxFirmwareCheck, pvvxFirmwareUrl).
 *
 * @param ctx What the core gives the plugins
 * @returns The started time sync and firmware updater
 */
export async function startPvvx(ctx: PluginContext): Promise<PluginInstance> {
	const { adapter, connections } = ctx;
	const timers = {
		setTimeout: (callback: () => void, ms: number) =>
			adapter.setTimeout(callback, ms),
		clearTimeout: (timer: any) => adapter.clearTimeout(timer),
		setInterval: (callback: () => void, ms: number) =>
			adapter.setInterval(callback, ms),
		clearInterval: (timer: any) => adapter.clearInterval(timer),
	};

	const list = parseDeviceList(adapter.config.pvvxDevices);
	for (const entry of list.invalid) {
		adapter.log.warn(`Ignoring the invalid pvvx device address "${entry}"`);
	}
	const interval = adapter.config.pvvxSyncInterval;

	// The driver asks the updater, which is created below
	const ref: { updater?: PvvxUpdater } = {};
	const driver = new PvvxDriver(
		{
			adapter,
			connections,
			clock: systemClock,
			...timers,
			isBusy: (address) => ref.updater?.isBusy(address) ?? false,
		},
		{
			addresses: list.addresses,
			syncIntervalHours:
				typeof interval === "number" && interval >= 0 ? interval : 24,
		},
	);

	const firmwareUrl = adapter.config.pvvxFirmwareUrl;
	const updater = new PvvxUpdater(
		{
			adapter,
			connections,
			catalog: new FirmwareCatalog(
				createHttpFirmwareSource(
					typeof firmwareUrl === "string" && firmwareUrl !== ""
						? firmwareUrl
						: DEFAULT_FIRMWARE_URL,
				),
				systemClock,
			),
			clock: systemClock,
			...timers,
			requestTimeSync: (address) => driver.requestSync(address),
		},
		{
			addresses: list.addresses,
			dailyCheck: adapter.config.pvvxFirmwareCheck !== false,
		},
	);

	ref.updater = updater;
	await driver.start();
	await updater.start();
	return {
		handleStateChange: (id, state) =>
			driver.handleStateChange(id, state) ||
			updater.handleStateChange(id, state),
		dispose: () => {
			// No new jobs for the connections
			updater.dispose();
			driver.dispose();
		},
	};
}
