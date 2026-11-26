import { GatewayError } from "../../lib/gateway-error";
import { parseGattRequest } from "../../lib/gatt-request";
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
				const { address } = parseGattRequest(message, {
					characteristic: false,
					data: false,
				});
				const { slot } = message as { slot?: unknown };
				if (
					typeof slot !== "number" ||
					!Number.isInteger(slot) ||
					slot < 1 ||
					slot > 4
				) {
					throw new GatewayError(
						"INVALID_PAYLOAD",
						"slot must be an integer from 1 to 4",
					);
				}
				return readSkyrcMc3000Slot(connections, address, slot);
			},
		},
	}),
};

export = plugin as Plugin;
