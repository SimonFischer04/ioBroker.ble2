import type { Plugin, PluginContext, PluginInstance } from "../plugins/plugin";
import type { PeripheralInfo } from "./advertisement";
import { toErrorResponse } from "./gateway-error";
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
	private disposed = false;
	/** Set while the plugins start, see start() */
	private starting: { namespace: string } | undefined;
	/** Changes of own states that arrived while the plugins were starting */
	private readonly held: {
		id: string;
		state: ioBroker.State | null | undefined;
	}[] = [];

	/**
	 * Starts the active part of every plugin that has one. A plugin that fails to start is reported
	 * and left out, the others start anyway.
	 *
	 * @param plugins All plugins
	 * @param ctx What the core gives the plugins
	 * @param reservedCommands Commands of the core, a plugin cannot take them over
	 */
	public async start(
		plugins: readonly Plugin[],
		ctx: PluginContext,
		reservedCommands: readonly string[] = [],
	): Promise<void> {
		// A button may be pressed as soon as its object exists, before its plugin finished starting
		this.starting = { namespace: ctx.adapter.namespace };
		try {
			await this.startAll(plugins, ctx, reservedCommands);
		} finally {
			this.starting = undefined;
		}
		for (const { id, state } of this.held.splice(0)) {
			this.handleStateChange(id, state);
		}
	}

	/**
	 * @param plugins All plugins
	 * @param ctx What the core gives the plugins
	 * @param reservedCommands Commands of the core
	 */
	private async startAll(
		plugins: readonly Plugin[],
		ctx: PluginContext,
		reservedCommands: readonly string[],
	): Promise<void> {
		for (const plugin of plugins) {
			if (!plugin.start || this.disposed) {
				continue;
			}
			let instance: PluginInstance;
			try {
				instance = await plugin.start(ctx);
			} catch (e) {
				this.log.error(
					`Plugin ${plugin.name} could not start: ${message(e)}`,
				);
				continue;
			}
			if (this.disposed) {
				instance.dispose?.();
				return;
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
					`Plugin ${name} failed to handle an advertisement: ${message(e)}`,
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
		if (
			this.starting &&
			id.startsWith(`${this.starting.namespace}.`) &&
			state?.ack === false
		) {
			// Passed on once all plugins have started
			this.held.push({ id, state });
			return false;
		}
		return this.started.some(
			({ instance }) => instance.handleStateChange?.(id, state) === true,
		);
	}

	/**
	 * Whether a plugin answers this sendTo command
	 *
	 * @param command Name of the command
	 */
	public hasCommand(command: string): boolean {
		return this.commands.has(command);
	}

	/**
	 * Runs a sendTo command of a plugin
	 *
	 * @param command Name of the command, see hasCommand()
	 * @param payload The message payload
	 * @returns The answer in the form of the gateway interface
	 */
	public async runCommand(
		command: string,
		payload: unknown,
	): Promise<GatewayResponse<unknown>> {
		const entry = this.commands.get(command);
		if (!entry) {
			return {
				error: {
					code: "INVALID_PAYLOAD",
					message: `Unknown command ${command}`,
				},
			};
		}
		try {
			return { error: null, result: await entry.handler(payload) };
		} catch (e) {
			return toErrorResponse(e);
		}
	}

	/** Stops all active parts, before the connections are closed */
	public dispose(): void {
		this.disposed = true;
		this.held.length = 0;
		for (const { name, instance } of this.started.splice(0)) {
			try {
				instance.dispose?.();
			} catch (e) {
				this.log.warn(`Plugin ${name} failed to stop: ${message(e)}`);
			}
		}
		this.commands.clear();
	}
}

/**
 * @param e Anything that was thrown
 * @returns Its message
 */
function message(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
