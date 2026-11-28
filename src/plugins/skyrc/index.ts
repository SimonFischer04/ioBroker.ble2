import { parseDeviceRequest, requireInteger } from "../../lib/gatt-request";
import { GatewayError } from "../../lib/gateway-error";
import { NO_DECODER, type Plugin } from "../plugin";
import { controlSkyrcMc3000Slot, readSkyrcMc3000Slot } from "./mc3000";

/** SkyRC MC3000 chargers: reads slot status and starts or stops configured programs */
const plugin: Plugin<undefined> = {
	name: "skyrc",
	description: "SkyRC MC3000 chargers through a gateway",
	...NO_DECODER,
	start: ({ connections }) => ({
		commands: {
			readSkyrcMc3000Slot: async (message) => {
				const { address, options } = parseDeviceRequest(message);
				const slot = requireInteger(message, "slot", 1, 4);
				return readSkyrcMc3000Slot(connections, address, slot, options);
			},
			controlSkyrcMc3000Slot: async (message) => {
				const { address, options } = parseDeviceRequest(message);
				const slot = requireInteger(message, "slot", 1, 4);
				const { action } = message as { action?: unknown };
				if (action !== "start" && action !== "stop") {
					throw new GatewayError(
						"INVALID_PAYLOAD",
						'"action" must be start or stop',
					);
				}
				await controlSkyrcMc3000Slot(
					connections,
					address,
					slot,
					action,
					options,
				);
				return { slot, action };
			},
		},
	}),
};

export = plugin as Plugin;
