import type { ConnectionManager } from "../../../connections/connection-manager";
import { PvvxCommandChannel } from "./command-channel";
import { formatVersion } from "./protocol";
import { type Clock, syncTime } from "./time-sync";
import { errorMessage } from "../../../lib/gateway-error";
import { describeError, writeStates } from "./states";

/** How often the driver checks which devices are due */
export const TICK_INTERVAL_MS = 60000;
/** First sync after the start, so gateways can announce themselves and receive the devices */
export const START_DELAY_MS = 60000;
/** Retries after errors */
export const RETRY_DELAYS_MS = [5, 15, 60].map((minutes) => minutes * 60000);
/** After the last retry, when there is no periodic sync */
export const FALLBACK_INTERVAL_MS = 24 * 3600000;
/** Time limit of one sync, connecting included */
export const SESSION_TIMEOUT_MS = 45000;

/** What the driver uses from the adapter, injected so tests can replace it */
export interface PvvxDriverContext {
	/** For the objects, states and log of the devices */
	adapter: Pick<
		ioBroker.Adapter,
		"namespace" | "log" | "setObjectNotExistsAsync" | "setStateAsync"
	>;
	/** Opens the GATT sessions to the devices */
	connections: Pick<ConnectionManager, "withSession">;
	/** Local time and time zone the clocks are set to */
	clock: Clock;
	/** Calls callback after ms, returns a handle for clearTimeout() */
	setTimeout(callback: () => void, ms: number): unknown;
	/** Cancels a timer started with setTimeout() */
	clearTimeout(timer: any): void;
	/** Calls callback every ms, returns a handle for clearInterval() */
	setInterval(callback: () => void, ms: number): unknown;
	/** Cancels a timer started with setInterval() */
	clearInterval(timer: any): void;
	/** Whether a firmware update of the device is queued or running, PvvxUpdater.isBusy() */
	isBusy?(address: string): boolean;
}

/** Settings of the time sync from the adapter configuration */
export interface PvvxDriverOptions {
	/** Devices whose clock is set, from parseDeviceList() */
	addresses: string[];
	/** Hours, 0 = no periodic sync */
	syncIntervalHours: number;
}

interface DeviceState {
	address: string;
	/** When the next sync is due (ms) */
	nextDue: number;
	/** Errors in a row */
	failures: number;
}

/** The objects of a device below <mac>.pvvx */
const STATES: Record<string, ioBroker.StateCommon> = {
	syncTime: {
		name: "Set the clock now",
		type: "boolean",
		role: "button",
		read: false,
		write: true,
	},
	lastTimeSync: {
		name: "Last time sync",
		type: "number",
		role: "date",
		read: true,
		write: false,
	},
	timeDeviation: {
		name: "Deviation of the clock before the last sync",
		type: "number",
		role: "value",
		unit: "s",
		read: true,
		write: false,
	},
	firmwareVersion: {
		name: "Firmware version",
		type: "string",
		role: "info.firmware",
		read: true,
		write: false,
	},
	hardwareId: {
		name: "Hardware ID",
		type: "number",
		role: "value",
		read: true,
		write: false,
	},
	lastError: {
		name: "Last error",
		type: "string",
		role: "text",
		read: true,
		write: false,
	},
};

/** Sets the clock of pvvx thermometers through the gateways that can connect */
export class PvvxDriver {
	/**
	 * Registers the devices; nothing happens until start() is called.
	 *
	 * @param ctx Adapter, connections, clock and timers
	 * @param options Devices and sync interval
	 */
	public constructor(
		private readonly ctx: PvvxDriverContext,
		private readonly options: PvvxDriverOptions,
	) {
		for (const address of options.addresses) {
			this.devices.set(address, {
				address,
				nextDue: Infinity,
				failures: 0,
			});
		}
	}

	private readonly devices = new Map<string, DeviceState>();
	private interval: unknown;
	private ticking = false;
	private disposed = false;
	private lastOffset = 0;

	private get intervalMs(): number {
		return this.options.syncIntervalHours * 3600000;
	}

	/** Creates the objects and starts the timer. Does nothing without addresses. */
	public async start(): Promise<void> {
		if (this.devices.size === 0) {
			return;
		}
		const { adapter, clock } = this.ctx;
		await Promise.all(
			[...this.devices.keys()].map((address) =>
				this.createObjects(address),
			),
		);
		const now = clock.now();
		for (const device of this.devices.values()) {
			device.nextDue = now + START_DELAY_MS;
			device.failures = 0;
		}
		this.lastOffset = clock.timezoneOffset(now);
		if (this.disposed) {
			return;
		}
		this.interval = this.ctx.setInterval(
			() => void this.tick(),
			TICK_INTERVAL_MS,
		);
		adapter.log.info(`pvvx time sync for ${this.devices.size} devices`);
	}

	private async createObjects(address: string): Promise<void> {
		const { adapter } = this.ctx;
		try {
			await adapter.setObjectNotExistsAsync(address, {
				type: "device",
				common: { name: address },
				native: { address },
			});
			await adapter.setObjectNotExistsAsync(`${address}.pvvx`, {
				type: "channel",
				common: { name: "pvvx firmware" },
				native: {},
			});
			await Promise.all(
				Object.entries(STATES).map(([id, common]) =>
					adapter.setObjectNotExistsAsync(`${address}.pvvx.${id}`, {
						type: "state",
						common,
						native: {},
					}),
				),
			);
		} catch (e) {
			adapter.log.warn(
				`Could not create the pvvx objects of ${address}: ${errorMessage(e)}`,
			);
		}
	}

	/** Runs all syncs that are due. Called by the timer, public for tests. Resolves when they are done. */
	public async tick(): Promise<void> {
		if (this.ticking || this.disposed) {
			return;
		}
		this.ticking = true;
		try {
			const { clock, adapter } = this.ctx;
			const now = clock.now();
			const offset = clock.timezoneOffset(now);
			if (offset !== this.lastOffset) {
				this.lastOffset = offset;
				adapter.log.info(
					"The UTC offset changed, setting the clock of all pvvx devices",
				);
				for (const device of this.devices.values()) {
					device.nextDue = now;
					device.failures = 0;
				}
			}
			const due = [...this.devices.values()]
				.filter((device) => device.nextDue <= now)
				.sort((a, b) => a.nextDue - b.nextDue);
			// One after the other: the gateways have few connection slots
			for (const device of due) {
				if (this.disposed) {
					break;
				}
				if (this.ctx.isBusy?.(device.address)) {
					// A firmware update would block the queue of the device, try again later
					device.nextDue = now + RETRY_DELAYS_MS[0];
					continue;
				}
				await this.sync(device);
			}
		} finally {
			this.ticking = false;
		}
	}

	private async sync(device: DeviceState): Promise<void> {
		const { ctx } = this;
		try {
			const result = await ctx.connections.withSession(
				device.address,
				async (session) => {
					const channel = new PvvxCommandChannel(session, ctx);
					await channel.open();
					return syncTime(channel, ctx.clock);
				},
				{ timeoutMs: SESSION_TIMEOUT_MS },
			);
			if (this.disposed) {
				return;
			}
			device.failures = 0;
			device.nextDue =
				this.intervalMs > 0
					? ctx.clock.now() + this.intervalMs
					: Infinity;
			await this.setStates(device.address, {
				timeDeviation: result.deviation,
				firmwareVersion: formatVersion(result.version),
				...(result.hardwareId !== undefined
					? { hardwareId: result.hardwareId }
					: {}),
				lastError: "",
				// Publish the completion timestamp after the other sync results.
				lastTimeSync: ctx.clock.now(),
			});
			ctx.adapter.log.info(
				`Set the clock of ${device.address}, it was ${result.deviation} s off`,
			);
		} catch (e) {
			if (this.disposed) {
				return;
			}
			const now = ctx.clock.now();
			device.failures++;
			const failures = device.failures;
			if (failures <= RETRY_DELAYS_MS.length) {
				device.nextDue = now + RETRY_DELAYS_MS[failures - 1];
			} else {
				device.nextDue =
					now + (this.intervalMs || FALLBACK_INTERVAL_MS);
				device.failures = 0;
			}
			const lastError = describeError(e);
			const message = `Could not set the clock of ${device.address}: ${lastError}`;
			if (failures === RETRY_DELAYS_MS.length) {
				ctx.adapter.log.warn(message);
			} else {
				ctx.adapter.log.info(message);
			}
			await this.setStates(device.address, { lastError });
		}
	}

	private setStates(
		address: string,
		values: Record<string, ioBroker.StateValue>,
	): Promise<void> {
		return writeStates(
			this.ctx.adapter,
			address,
			values,
			() => this.disposed,
		);
	}

	/**
	 * Handles the button. Returns true if the state belongs to this driver.
	 *
	 * @param id Full ID of the changed state
	 * @param state The new state, null or undefined if it was deleted
	 */
	public handleStateChange(
		id: string,
		state: ioBroker.State | null | undefined,
	): boolean {
		const prefix = `${this.ctx.adapter.namespace}.`;
		const match = id.startsWith(prefix)
			? /^(.+)\.pvvx\.syncTime$/.exec(id.slice(prefix.length))
			: null;
		const device = match ? this.devices.get(match[1]) : undefined;
		if (!device) {
			return false;
		}
		if (!state || state.ack === true || !state.val || this.disposed) {
			return true;
		}
		this.ctx.adapter.setStateAsync(id, false, true).catch(() => {});
		this.requestSync(device.address);
		return true;
	}

	/**
	 * Sets the clock of the device soon, like the button, e.g. after a firmware update
	 *
	 * @param address MAC address of the device
	 */
	public requestSync(address: string): void {
		const device = this.devices.get(address);
		if (!device || this.disposed) {
			return;
		}
		device.nextDue = 0;
		device.failures = 0;
		// While a tick runs, the device comes next time
		void this.tick();
	}

	/** Stops the timer when the adapter unloads; running syncs are not started again. */
	public dispose(): void {
		this.disposed = true;
		if (this.interval !== undefined) {
			this.ctx.clearInterval(this.interval);
			this.interval = undefined;
		}
	}
}
