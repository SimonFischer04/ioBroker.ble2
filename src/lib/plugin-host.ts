import type { Plugin, PluginContext, PluginInstance } from "../plugins/plugin";
import type { PeripheralInfo } from "./advertisement";
import { errorMessage, toResponse } from "./gateway-error";
import type { GatewayResponse } from "./gateway-protocol";

/** A started active part, with the plugin it belongs to */
interface StartedPlugin {
	name: string;
	instance: PluginInstance;
}

/**
 * Runs the active parts of the plugins (Plugin.start). The core of the adapter knows no manufacturer:
 * it hands every advertisement, state change and unknown command to the plugins through this host.
 */
export class PluginHost {
	/**
	 * @param log Where problems of a plugin are reported
	 */
	public constructor(
		private readonly log: Pick<ioBroker.Logger, "info" | "warn" | "error">,
	) {}

	private readonly started: StartedPlugin[] = [];
	/** sendTo commands of the plugins, by command name */
	private readonly commands = new Map<
		string,
		{ plugin: string; handler: (message: unknown) => Promise<unknown> }
	>();

	/**
	 * Starts the active part of every plugin that has one. A plugin that fails to start is reported
	 * and left out, the others start anyway. The plugins return at once, so their handlers and
	 * commands are available right away; they set themselves up in the background.
	 *
	 * @param plugins All plugins
	 * @param ctx What the core gives the plugins
	 * @param reservedCommands Commands of the core, a plugin cannot take them over
	 */
	public start(
		plugins: readonly Plugin[],
		ctx: PluginContext,
		reservedCommands: readonly string[] = [],
	): void {
		for (const plugin of plugins) {
			if (!plugin.start) {
				continue;
			}
			let instance: PluginInstance;
			try {
				instance = plugin.start(ctx);
			} catch (e) {
				this.log.error(
					`Plugin ${plugin.name} could not start: ${errorMessage(e)}`,
				);
				continue;
			}
			this.started.push({ name: plugin.name, instance });
			for (const [command, handler] of Object.entries(
				instance.commands ?? {},
			)) {
				const owner = this.commands.get(command)?.plugin;
				if (reservedCommands.includes(command) || owner) {
					this.log.warn(
						`Plugin ${plugin.name} cannot use the command "${command}", it belongs to ${owner ?? "the adapter"}`,
					);
					continue;
				}
				this.commands.set(command, { plugin: plugin.name, handler });
			}
		}
	}

	/**
	 * Hands a received advertisement to every plugin that wants to see it
	 *
	 * @param peripheral The advertisement
	 */
	public observe(peripheral: PeripheralInfo): void {
		for (const { name, instance } of this.started) {
			try {
				instance.observe?.(peripheral);
			} catch (e) {
				this.log.warn(
					`Plugin ${name} failed to handle an advertisement: ${errorMessage(e)}`,
				);
			}
		}
	}

	/**
	 * Hands a state change to the plugins until one of them takes it
	 *
	 * @param id ID of the state
	 * @param state The new state
	 * @returns Whether a plugin took it
	 */
	public handleStateChange(
		id: string,
		state: ioBroker.State | null | undefined,
	): boolean {
		return this.started.some(
			({ instance }) => instance.handleStateChange?.(id, state) === true,
		);
	}

	/**
	 * Runs a sendTo command of a plugin
	 *
	 * @param command Name of the command
	 * @param payload The message payload
	 * @returns The answer in the form of the gateway interface, undefined if no plugin has the command
	 */
	public runCommand(
		command: string,
		payload: unknown,
	): Promise<GatewayResponse<unknown>> | undefined {
		const entry = this.commands.get(command);
		return entry && toResponse(() => entry.handler(payload));
	}

	/** Stops all active parts, before the connections are closed */
	public dispose(): void {
		for (const { name, instance } of this.started.splice(0)) {
			try {
				instance.dispose?.();
			} catch (e) {
				this.log.warn(
					`Plugin ${name} failed to stop: ${errorMessage(e)}`,
				);
			}
		}
		this.commands.clear();
	}
}
