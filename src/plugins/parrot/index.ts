// Declares the settings of this plugin
import type {} from "./config";
import { parseDeviceList } from "../../lib/device-list";
import { NO_DECODER, type Plugin } from "../plugin";
import { FlowerPower } from "./flower-power";

/** Parrot Flower Power: reads the configured sensors over a gateway (setting flowerPowerDevices) */
const plugin: Plugin<undefined> = {
	name: "parrot",
	description: "Parrot Flower Power sensors, read over a gateway",
	...NO_DECODER,
	start: ({ adapter, connections }) => {
		const sensors = parseDeviceList(adapter.config.flowerPowerDevices);
		for (const address of sensors.invalid) {
			adapter.log.warn(
				`Ignoring invalid Flower Power sensor address "${address}"`,
			);
		}
		const flowerPower =
			sensors.addresses.length > 0
				? new FlowerPower(adapter, connections, sensors.addresses)
				: undefined;
		return {
			observe: (peripheral) => flowerPower?.observe(peripheral),
			dispose: () => flowerPower?.dispose(),
		};
	},
};

export = plugin as Plugin;
