import { parseDeviceRequest, requireInteger } from "../../lib/gatt-request";
import { NO_DECODER, type Plugin } from "../plugin";
import { readSkyrcMc3000Slot } from "./mc3000";

/** SkyRC MC3000 chargers: reads the status of a slot over a gateway (command readSkyrcMc3000Slot) */
const plugin: Plugin<undefined> = {
	name: "skyrc",
	description: "SkyRC MC3000 chargers, read over a gateway",
	...NO_DECODER,
	start: ({ connections }) => ({
		commands: {
			readSkyrcMc3000Slot: async (message) => {
				const { address, options } = parseDeviceRequest(message);
				const slot = requireInteger(message, "slot", 1, 4);
				return readSkyrcMc3000Slot(connections, address, slot, options);
			},
		},
	}),
};

export = plugin as Plugin;
