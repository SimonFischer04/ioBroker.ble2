import { parseDeviceRequest } from "../../lib/gatt-request";
import { NO_DECODER, type Plugin } from "../plugin";
import { readCometBlue } from "./comet-blue";

/** Eurotronic Comet Blue thermostats: reads the status over a gateway (command readCometBlue) */
const plugin: Plugin<undefined> = {
	name: "comet-blue",
	description: "Comet Blue thermostats, read over a gateway",
	...NO_DECODER,
	start: ({ connections }) => ({
		commands: {
			readCometBlue: async (message) => {
				const { address, options } = parseDeviceRequest(message);
				const { pin } = message as { pin?: unknown };
				return readCometBlue(connections, address, pin, options);
			},
		},
	}),
};

export = plugin as Plugin;
