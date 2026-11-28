import { parseDeviceRequest } from "../../lib/gatt-request";
import type { PluginContext, PluginInstance } from "../plugin";
import { runSwitchBotAction } from "./bot";

/**
 * Active part of the plugin "switchbot": actions of a SwitchBot Bot (command switchBot)
 *
 * @param ctx What the core gives the plugins
 * @returns The command switchBot
 */
export function startSwitchBot(ctx: PluginContext): PluginInstance {
	return {
		commands: {
			switchBot: async (message) => {
				const { address, options } = parseDeviceRequest(message);
				const { action } = message as { action?: unknown };
				return runSwitchBotAction(
					ctx.connections,
					address,
					action,
					options,
				);
			},
		},
	};
}
