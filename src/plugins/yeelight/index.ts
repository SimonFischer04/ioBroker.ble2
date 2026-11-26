import { GatewayError } from "../../lib/gateway-error";
import { parseGattRequest } from "../../lib/gatt-request";
import { NO_DECODER, type Plugin } from "../plugin";
import { setCandelaBrightness } from "./candela";

/** Yeelight Candela: sets the brightness over a gateway (command setCandelaBrightness) */
const plugin: Plugin<undefined> = {
	name: "yeelight",
	description: "Yeelight Candela lamps, controlled over a gateway",
	...NO_DECODER,
	start: ({ connections, devices }) => ({
		commands: {
			setCandelaBrightness: async (message) => {
				const { address } = parseGattRequest(message, {
					characteristic: false,
					data: false,
				});
				const { brightness } = message as { brightness?: unknown };
				if (
					typeof brightness !== "number" ||
					!Number.isInteger(brightness) ||
					brightness < 0 ||
					brightness > 100
				) {
					throw new GatewayError(
						"INVALID_PAYLOAD",
						"brightness must be a whole number from 0 to 100",
					);
				}
				const device = devices
					.getDevices()
					.find((entry) => entry.address === address);
				if (device?.name?.toLowerCase() !== "yeelight_ms") {
					throw new GatewayError(
						"GATT_ERROR",
						"The device has not advertised as a Yeelight Candela",
					);
				}
				await setCandelaBrightness(connections, address, brightness);
				return { brightness };
			},
		},
	}),
};

export = plugin as Plugin;
