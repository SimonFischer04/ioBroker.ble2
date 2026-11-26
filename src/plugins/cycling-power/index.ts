// Declares the settings of this plugin
import type {} from "./config";
import { parseDeviceList } from "../../lib/device-list";
import { NO_DECODER, type Plugin } from "../plugin";
import { CyclingPower } from "./cycling-power";

/** Cycling Power sensors (GATT service 0x1818): subscribes to the measurements (setting cyclingPowerDevices) */
const plugin: Plugin<undefined> = {
	name: "cycling-power",
	description: "Cycling Power sensors, read over a gateway",
	...NO_DECODER,
	start: ({ adapter, connections }) => {
		const sensors = parseDeviceList(adapter.config.cyclingPowerDevices);
		for (const address of sensors.invalid) {
			adapter.log.warn(
				`Ignoring invalid Cycling Power sensor address "${address}"`,
			);
		}
		const cyclingPower =
			sensors.addresses.length > 0
				? new CyclingPower(adapter, connections, sensors.addresses)
				: undefined;
		return {
			observe: (peripheral) => cyclingPower?.observe(peripheral),
			dispose: () => cyclingPower?.dispose(),
		};
	},
};

export = plugin as Plugin;
