// Declares the settings of this plugin
import type {} from "./config";
import { readDeviceList } from "../../lib/device-list";
import { NO_DECODER, type Plugin } from "../plugin";
import { FlowerPower } from "./flower-power";

/** Parrot Flower Power: reads the configured sensors over a gateway (setting flowerPowerDevices) */
const plugin: Plugin<undefined> = {
	name: "parrot",
	description: "Parrot Flower Power sensors, read over a gateway",
	...NO_DECODER,
	start: ({ adapter, connections }) => {
		const flowerPower = new FlowerPower(
			adapter,
			connections,
			readDeviceList(
				adapter,
				adapter.config.flowerPowerDevices,
				"Flower Power sensor",
			),
		);
		return {
			observe: (peripheral) => flowerPower.observe(peripheral),
			dispose: () => flowerPower.dispose(),
		};
	},
};

export = plugin as Plugin;
