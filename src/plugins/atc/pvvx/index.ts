// Declares the settings of this plugin
import type {} from "./config";
import { readDeviceList } from "../../../lib/device-list";
import { errorMessage } from "../../../lib/gateway-error";
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
export function startPvvx(ctx: PluginContext): PluginInstance {
	const { adapter, connections } = ctx;
	const timers = {
		setTimeout: (callback: () => void, ms: number) =>
			adapter.setTimeout(callback, ms),
		clearTimeout: (timer: any) => adapter.clearTimeout(timer),
		setInterval: (callback: () => void, ms: number) =>
			adapter.setInterval(callback, ms),
		clearInterval: (timer: any) => adapter.clearInterval(timer),
	};

	const addresses = readDeviceList(
		adapter,
		adapter.config.pvvxDevices,
		"pvvx device",
	);
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
			addresses,
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
			addresses,
			dailyCheck: adapter.config.pvvxFirmwareCheck !== false,
		},
	);

	ref.updater = updater;
	// Objects and states are set up in the background, both know their devices already
	Promise.all([driver.start(), updater.start()]).catch((e: unknown) =>
		adapter.log.warn(`pvvx could not start: ${errorMessage(e)}`),
	);
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
