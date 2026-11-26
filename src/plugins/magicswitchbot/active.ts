import { GatewayError } from "../../lib/gateway-error";
import { parseGattRequest } from "../../lib/gatt-request";
import type { PluginContext, PluginInstance } from "../plugin";
import { runMagicSwitchBotAction } from "./actions";

/**
 * Active part of the plugin "magicswitchbot": actions of a MagicSwitchBot (command runMagicSwitchBotAction)
 *
 * @param ctx What the core gives the plugins
 * @returns The command runMagicSwitchBotAction
 */
export function startMagicSwitchBot(ctx: PluginContext): PluginInstance {
	return {
		commands: {
			runMagicSwitchBotAction: async (message) => {
				const { address } = parseGattRequest(message, {
					characteristic: false,
					data: false,
				});
				const { action, pin } = message as Record<string, unknown>;
				if (action !== "on" && action !== "off" && action !== "push") {
					throw new GatewayError(
						"INVALID_PAYLOAD",
						"action must be on, off or push",
					);
				}
				if (
					pin !== undefined &&
					(typeof pin !== "string" || !/^\d{6}$/.test(pin))
				) {
					throw new GatewayError(
						"INVALID_PAYLOAD",
						"pin must be a six-digit string",
					);
				}
				await runMagicSwitchBotAction(
					ctx.connections,
					address,
					action,
					pin,
				);
				return { action };
			},
		},
	};
}
