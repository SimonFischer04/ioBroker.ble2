// Declares the settings of this plugin
import type {} from "./config";
import { readDeviceList } from "../../lib/device-list";
import { NO_DECODER, type Plugin } from "../plugin";
import { CyclingPower } from "./cycling-power";

/** Cycling Power sensors (GATT service 0x1818): subscribes to the measurements (setting cyclingPowerDevices) */
const plugin: Plugin<undefined> = {
	name: "cycling-power",
	description: "Cycling Power sensors, read over a gateway",
	...NO_DECODER,
	start: ({ adapter, connections }) => {
		const cyclingPower = new CyclingPower(
			adapter,
			connections,
			readDeviceList(
				adapter,
				adapter.config.cyclingPowerDevices,
				"Cycling Power sensor",
			),
		);
		return {
			observe: (peripheral) => cyclingPower.observe(peripheral),
			dispose: () => cyclingPower.dispose(),
		};
	},
};

export = plugin as Plugin;
