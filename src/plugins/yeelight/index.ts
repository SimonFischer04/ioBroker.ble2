import { GatewayError } from "../../lib/gateway-error";
import { parseDeviceRequest, requireInteger } from "../../lib/gatt-request";
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
				const { address, options } = parseDeviceRequest(message);
				const brightness = requireInteger(
					message,
					"brightness",
					0,
					100,
				);
				const device = devices
					.getDevices()
					.find((entry) => entry.address === address);
				if (device?.name?.toLowerCase() !== "yeelight_ms") {
					throw new GatewayError(
						"GATT_ERROR",
						"The device has not advertised as a Yeelight Candela",
					);
				}
				await setCandelaBrightness(
					connections,
					address,
					brightness,
					options,
				);
				return { brightness };
			},
		},
	}),
};

export = plugin as Plugin;
