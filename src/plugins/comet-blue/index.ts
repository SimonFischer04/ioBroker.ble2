import { parseDeviceRequest } from "../../lib/gatt-request";
import { NO_DECODER, type Plugin } from "../plugin";
import { readCometBlue, setCometBlueSetpoints } from "./comet-blue";

/** Eurotronic Comet Blue thermostats: reads status and writes setpoints through a gateway */
const plugin: Plugin<undefined> = {
	name: "comet-blue",
	description: "Comet Blue thermostats through a gateway",
	...NO_DECODER,
	start: ({ connections }) => ({
		commands: {
			readCometBlue: async (message) => {
				const { address, options } = parseDeviceRequest(message);
				const { pin } = message as { pin?: unknown };
				return readCometBlue(connections, address, pin, options);
			},
			setCometBlueSetpoints: async (message) => {
				const { address, options } = parseDeviceRequest(message);
				await setCometBlueSetpoints(
					connections,
					address,
					message as Record<string, unknown>,
					options,
				);
				return {};
			},
		},
	}),
};

export = plugin as Plugin;
