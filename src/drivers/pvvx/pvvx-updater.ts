import type { ConnectionManager } from "../../connections/connection-manager";
import { PvvxCommandChannel } from "./command-channel";
import { type FirmwareCatalog, selectImage } from "./firmware-catalog";
import { checkPreconditions } from "./ota-checks";
import { transferImage } from "./ota-transfer";
import {
	encodeConfigRequest,
	formatVersion,
	parseConfigResponse,
} from "./protocol";
import { type Clock, PvvxProtocolError } from "./time-sync";
import { PvvxUpdateError } from "./update-error";

/** First check for new firmware after the start */
export const CHECK_START_DELAY_MS = 120000;
/** Interval of the daily check */
export const CHECK_INTERVAL_MS = 24 * 3600000;
/** Time limit of the update session, docs/spec-phase-4-pvvx-ota.md section 0, H4 */
export const OTA_SESSION_TIMEOUT_MS = 600000;
/** Wait after the end packet, H5 */
export const VERIFY_DELAY_MS = 15000;
/** Attempts to read the new version, H5 */
export const VERIFY_ATTEMPTS = 3;
/** Pause between the attempts, H5 */
export const VERIFY_RETRY_MS = 30000;
/** firmwareProgress is only written when it changed by at least this many percentage points */
export const PROGRESS_STEP = 1;
const VERIFY_SESSION_TIMEOUT_MS = 45000;

export const FIRMWARE_STATUS = [
	"idle",
	"queued",
	"checking",
	"transferring",
	"verifying",
	"done",
	"failed",
] as const;
export type FirmwareStatus = (typeof FIRMWARE_STATUS)[number];
const BUSY_STATUS: unknown[] = [
	"queued",
	"checking",
	"transferring",
	"verifying",
];

/** The objects of a device below <mac>.pvvx */
const DEVICE_STATES: Record<string, ioBroker.StateCommon> = {
	firmwareAvailable: {
		name: "Newer firmware that can be installed",
		type: "string",
		role: "text",
		read: true,
		write: false,
	},
	firmwareUpdate: {
		name: "Install the newer firmware",
		type: "boolean",
		role: "button",
		read: false,
		write: true,
	},
	firmwareProgress: {
		name: "Progress of the firmware update",
		type: "number",
		role: "value",
		unit: "%",
		min: 0,
		max: 100,
		read: true,
		write: false,
	},
	firmwareStatus: {
		name: "Status of the firmware update",
		type: "string",
		role: "text",
		read: true,
		write: false,
		states: Object.fromEntries(FIRMWARE_STATUS.map((s) => [s, s])),
	},
	firmwareError: {
		name: "Last error of the firmware update",
		type: "string",
		role: "text",
		read: true,
		write: false,
	},
};

/** The objects of the instance below pvvx */
const INSTANCE_STATES: Record<string, ioBroker.StateCommon> = {
	checkFirmware: {
		name: "Check for new firmware now",
		type: "boolean",
		role: "button",
		read: false,
		write: true,
	},
	updateAll: {
		name: "Install the newer firmware on all devices",
		type: "boolean",
		role: "button",
		read: false,
		write: true,
	},
};

export interface PvvxUpdaterContext {
	adapter: Pick<
		ioBroker.Adapter,
		| "namespace"
		| "log"
		| "setObjectNotExistsAsync"
		| "setStateAsync"
		| "getStateAsync"
	>;
	connections: Pick<ConnectionManager, "withSession" | "bestGateway">;
	catalog: FirmwareCatalog;
	clock: Clock;
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(timer: any): void;
	setInterval(callback: () => void, ms: number): unknown;
	clearInterval(timer: any): void;
	/** Sets the clock of the device soon, PvvxDriver.requestSync() */
	requestTimeSync(address: string): void;
}

export interface PvvxUpdaterOptions {
	addresses: string[];
	/** Setting pvvxFirmwareCheck */
	dailyCheck: boolean;
}

interface QueuedUpdate {
	address: string;
	finished: () => void;
}

function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

function errorCode(e: unknown): string {
	const code = (e as { code?: unknown } | null | undefined)?.code;
	return typeof code === "string" ? code : "ERROR";
}

/**
 * "5.9" -> 0x59, undefined for anything else
 *
 * @param value
 */
function parseVersion(value: unknown): number | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const match = /^(\d+)\.(\d+)$/.exec(value);
	if (!match) {
		return undefined;
	}
	const major = Number(match[1]);
	const minor = Number(match[2]);
	if (major > 15 || minor > 15) {
		return undefined;
	}
	return (major << 4) | minor;
}

/** Installs newer pvvx firmware on the configured devices, one after the other */
export class PvvxUpdater {
	public constructor(
		private readonly ctx: PvvxUpdaterContext,
		private readonly options: PvvxUpdaterOptions,
	) {}

	private readonly queue: QueuedUpdate[] = [];
	/** Queued and running updates */
	private readonly busy = new Set<string>();
	private running = false;
	private checking = false;
	private disposed = false;
	private readonly timers = new Set<unknown>();
	private interval: unknown;
	private readonly lastProgress = new Map<string, number>();

	/** Creates the objects, schedules the checks. Does nothing without addresses. */
	public async start(): Promise<void> {
		if (this.options.addresses.length === 0) {
			return;
		}
		const { adapter } = this.ctx;
		try {
			await adapter.setObjectNotExistsAsync("pvvx", {
				type: "channel",
				common: { name: "pvvx firmware" },
				native: {},
			});
			for (const [id, common] of Object.entries(INSTANCE_STATES)) {
				await adapter.setObjectNotExistsAsync(`pvvx.${id}`, {
					type: "state",
					common,
					native: {},
				});
			}
			for (const address of this.options.addresses) {
				for (const [id, common] of Object.entries(DEVICE_STATES)) {
					await adapter.setObjectNotExistsAsync(
						`${address}.pvvx.${id}`,
						{ type: "state", common, native: {} },
					);
				}
			}
		} catch (e) {
			adapter.log.warn(
				`Could not create the pvvx firmware objects: ${errorMessage(e)}`,
			);
		}

		for (const address of this.options.addresses) {
			let status: ioBroker.State | null | undefined;
			try {
				status = await adapter.getStateAsync(
					`${address}.pvvx.firmwareStatus`,
				);
			} catch {
				status = undefined;
			}
			if (status?.val == undefined) {
				await this.setStates(address, {
					firmwareStatus: "idle",
					firmwareProgress: 0,
				});
			} else if (BUSY_STATUS.includes(status.val)) {
				// The adapter stopped in the middle of an update
				await this.setStates(address, {
					firmwareStatus: "idle",
					firmwareProgress: 0,
					firmwareError:
						"NOT_CONNECTED: The adapter was restarted during the update",
				});
			}
		}

		if (this.options.dailyCheck && !this.disposed) {
			const timer = this.ctx.setTimeout(() => {
				this.timers.delete(timer);
				void this.checkAll(false);
			}, CHECK_START_DELAY_MS);
			this.timers.add(timer);
			this.interval = this.ctx.setInterval(
				() => void this.checkAll(false),
				CHECK_INTERVAL_MS,
			);
		}
	}

	/**
	 * Updates firmwareAvailable of all devices, without connecting to them. Public for tests.
	 *
	 * @param refresh
	 */
	public async checkAll(refresh: boolean): Promise<void> {
		if (this.checking || this.disposed) {
			return;
		}
		this.checking = true;
		const { adapter, catalog } = this.ctx;
		try {
			let index;
			try {
				index = await catalog.getIndex(refresh);
			} catch (e) {
				adapter.log.warn(
					`Could not load the pvvx firmware list: ${errorMessage(e)}`,
				);
				return;
			}
			for (const address of this.options.addresses) {
				if (this.disposed) {
					return;
				}
				try {
					const hardwareId = (
						await adapter.getStateAsync(
							`${address}.pvvx.hardwareId`,
						)
					)?.val;
					const version = parseVersion(
						(
							await adapter.getStateAsync(
								`${address}.pvvx.firmwareVersion`,
							)
						)?.val,
					);
					if (
						typeof hardwareId !== "number" ||
						version === undefined
					) {
						continue;
					}
					const selection = selectImage(index, hardwareId, version);
					await this.setStates(address, {
						firmwareAvailable:
							"path" in selection
								? formatVersion(selection.version)
								: "",
					});
				} catch (e) {
					adapter.log.warn(
						`Could not check the firmware of ${address}: ${errorMessage(e)}`,
					);
				}
			}
		} finally {
			this.checking = false;
		}
	}

	/**
	 * Whether an update of the device is queued or running
	 *
	 * @param address
	 */
	public isBusy(address: string): boolean {
		return this.busy.has(address);
	}

	/**
	 * Queues the update of a device. Resolves when it is finished (done or failed). Public for tests.
	 *
	 * @param address
	 */
	public update(address: string): Promise<void> {
		if (this.disposed || !this.options.addresses.includes(address)) {
			return Promise.resolve();
		}
		if (this.busy.has(address)) {
			this.ctx.adapter.log.info(
				`The firmware update of ${address} is already queued`,
			);
			return Promise.resolve();
		}
		this.busy.add(address);
		return new Promise<void>((finished) => {
			this.queue.push({ address, finished });
			this.lastProgress.set(address, 0);
			void this.setStates(address, {
				firmwareStatus: "queued",
				firmwareProgress: 0,
			}).then(() => this.pump());
		});
	}

	/** Starts the next update, if none is running */
	private async pump(): Promise<void> {
		if (this.running || this.disposed) {
			return;
		}
		const next = this.queue.shift();
		if (!next) {
			return;
		}
		this.running = true;
		let updated = false;
		try {
			updated = await this.run(next.address);
		} finally {
			this.running = false;
			this.busy.delete(next.address);
		}
		// The clock may be wrong after the restart. Only now: the time sync skips busy devices.
		if (updated && !this.disposed) {
			this.ctx.requestTimeSync(next.address);
		}
		next.finished();
		void this.pump();
	}

	/**
	 * @param address
	 * @returns Whether the device runs the new firmware now
	 */
	private async run(address: string): Promise<boolean> {
		const { ctx } = this;
		try {
			await this.setStates(address, { firmwareStatus: "checking" });
			let battery: ioBroker.State | null | undefined;
			try {
				battery = await ctx.adapter.getStateAsync(`${address}.battery`);
			} catch {
				battery = undefined;
			}
			checkPreconditions({
				address,
				now: ctx.clock.now(),
				battery,
				bestGateway: ctx.connections.bestGateway(
					address,
					"writeSequence",
				),
			});
			const index = await ctx.catalog.getIndex(false);

			let expected = 0;
			await ctx.connections.withSession(
				address,
				async (session) => {
					const channel = new PvvxCommandChannel(session, ctx);
					await channel.open();
					const config = parseConfigResponse(
						await channel.request(encodeConfigRequest()),
					);
					if (!config) {
						throw new PvvxProtocolError(
							"The device did not answer like a pvvx firmware",
						);
					}
					const selection = selectImage(
						index,
						config.hardwareId,
						config.version,
					);
					if ("problem" in selection) {
						const id = config.hardwareId ?? "unknown";
						const messages = {
							UP_TO_DATE: `Version ${formatVersion(config.version)} is installed, ${formatVersion(index.version)} is the newest`,
							UNKNOWN_HARDWARE: `Hardware ID ${id} is not in firmware.json`,
							NO_IMAGE: `There is no BLE firmware for hardware ID ${id}`,
						};
						throw new PvvxUpdateError(
							selection.problem,
							messages[selection.problem],
						);
					}
					const { image, length } = await ctx.catalog.getImage(
						selection.path,
					);
					await this.setStates(address, {
						firmwareStatus: "transferring",
					});
					await transferImage(session, image, length, {
						onProgress: (fraction) =>
							this.reportProgress(address, fraction),
						sleep: (ms) => this.sleep(ms),
					});
					expected = selection.version;
				},
				{
					priority: "high",
					timeoutMs: OTA_SESSION_TIMEOUT_MS,
					requireFeature: "writeSequence",
				},
			);

			await this.setStates(address, { firmwareStatus: "verifying" });
			await this.verify(address, expected);

			await this.setStates(address, {
				firmwareVersion: formatVersion(expected),
				firmwareAvailable: "",
				firmwareProgress: 100,
				firmwareError: "",
				firmwareStatus: "done",
			});
			if (this.disposed) {
				return false;
			}
			ctx.adapter.log.info(
				`Updated the firmware of ${address} to ${formatVersion(expected)}`,
			);
			return true;
		} catch (e) {
			if (this.disposed) {
				return false;
			}
			const firmwareError = `${errorCode(e)}: ${errorMessage(e)}`;
			ctx.adapter.log.warn(
				`The firmware update of ${address} failed: ${firmwareError}`,
			);
			await this.setStates(address, {
				firmwareStatus: "failed",
				firmwareError,
			});
			return false;
		}
	}

	/**
	 * Waits for the restart and checks that the device runs the new version
	 *
	 * @param address
	 * @param expected
	 */
	private async verify(address: string, expected: number): Promise<void> {
		await this.sleep(VERIFY_DELAY_MS);
		let lastError: unknown;
		for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt++) {
			if (attempt > 0) {
				await this.sleep(VERIFY_RETRY_MS);
			}
			let version: number;
			try {
				version = await this.ctx.connections.withSession(
					address,
					async (session) => {
						const channel = new PvvxCommandChannel(
							session,
							this.ctx,
						);
						await channel.open();
						const config = parseConfigResponse(
							await channel.request(encodeConfigRequest()),
						);
						if (!config) {
							throw new PvvxProtocolError(
								"The device did not answer like a pvvx firmware",
							);
						}
						return config.version;
					},
					{ timeoutMs: VERIFY_SESSION_TIMEOUT_MS },
				);
			} catch (e) {
				lastError = e;
				continue;
			}
			if (version === expected) {
				return;
			}
			throw new PvvxUpdateError(
				"VERIFY_FAILED",
				`Version ${formatVersion(version)} after the update, expected ${formatVersion(expected)}`,
			);
		}
		throw new PvvxUpdateError(
			"VERIFY_FAILED",
			`The device could not be reached after the update: ${errorMessage(lastError)}`,
		);
	}

	private reportProgress(address: string, fraction: number): void {
		// 100 only after the new version was read
		const value = Math.floor(fraction * 99);
		const last = this.lastProgress.get(address) ?? 0;
		if (value - last < PROGRESS_STEP) {
			return;
		}
		this.lastProgress.set(address, value);
		void this.setStates(address, { firmwareProgress: value });
	}

	/**
	 * Waits. After dispose() it never resolves, so nothing goes on.
	 *
	 * @param ms
	 */
	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => {
			const timer = this.ctx.setTimeout(() => {
				this.timers.delete(timer);
				if (!this.disposed) {
					resolve();
				}
			}, ms);
			this.timers.add(timer);
		});
	}

	private async setStates(
		address: string,
		values: Record<string, ioBroker.StateValue>,
	): Promise<void> {
		for (const [id, value] of Object.entries(values)) {
			if (this.disposed) {
				return;
			}
			try {
				await this.ctx.adapter.setStateAsync(
					`${address}.pvvx.${id}`,
					value,
					true,
				);
			} catch (e) {
				this.ctx.adapter.log.warn(
					`Could not write ${address}.pvvx.${id}: ${errorMessage(e)}`,
				);
			}
		}
	}

	/** Starts the update of every device with a newer firmware, in the order of the setting */
	private async updateAll(): Promise<void> {
		for (const address of this.options.addresses) {
			let available: unknown;
			try {
				available = (
					await this.ctx.adapter.getStateAsync(
						`${address}.pvvx.firmwareAvailable`,
					)
				)?.val;
			} catch {
				available = undefined;
			}
			if (typeof available === "string" && available !== "") {
				void this.update(address);
			}
		}
	}

	/**
	 * Handles the buttons. Returns true if the state belongs to the updater.
	 *
	 * @param id
	 * @param state
	 */
	public handleStateChange(
		id: string,
		state: ioBroker.State | null | undefined,
	): boolean {
		const prefix = `${this.ctx.adapter.namespace}.`;
		if (!id.startsWith(prefix)) {
			return false;
		}
		const relative = id.slice(prefix.length);

		let action: (() => void) | undefined;
		if (relative === "pvvx.updateAll") {
			action = () => void this.updateAll();
		} else if (relative === "pvvx.checkFirmware") {
			action = () => void this.checkAll(true);
		} else {
			const match = /^(.+)\.pvvx\.firmwareUpdate$/.exec(relative);
			if (!match || !this.options.addresses.includes(match[1])) {
				return false;
			}
			const address = match[1];
			action = () => void this.update(address);
		}

		if (!state || state.ack === true || !state.val || this.disposed) {
			return true;
		}
		this.ctx.adapter.setStateAsync(id, false, true).catch(() => {});
		action();
		return true;
	}

	public dispose(): void {
		this.disposed = true;
		for (const timer of this.timers) {
			this.ctx.clearTimeout(timer);
		}
		this.timers.clear();
		if (this.interval !== undefined) {
			this.ctx.clearInterval(this.interval);
			this.interval = undefined;
		}
		this.queue.length = 0;
	}
}
