import { fork, type ChildProcess } from "child_process";
import * as path from "path";
import { performance } from "node:perf_hooks";
import type { GatewayDescription } from "../gateways/gateway-registry";
import {
	ScanExitCodes,
	getMessageReviver,
	type ScanMessage,
} from "../lib/scanProcessInterface";
import { classifyScanError } from "./scan-errors";
import type { Transport, TransportContext } from "./transport";

/** Settings for the scanner process of the local Bluetooth adapter */
export interface NobleLocalOptions {
	/** Which BLE services to scan for. Empty = all. */
	services: string[];
	/** Bluetooth company identifiers to accept */
	manufacturerIds: readonly number[];
	/** Index of the HCI device to use */
	hciDevice?: number;
}

const NATIVE_CRASH_SIGNALS: ReadonlySet<NodeJS.Signals> = new Set([
	"SIGABRT",
	"SIGBUS",
	"SIGILL",
	"SIGSEGV",
	"SIGTRAP",
]);
const INITIAL_RESTART_DELAY_MS = 1000;
const MAX_RESTART_DELAY_MS = 60_000;
const STABLE_SCANNER_UPTIME_MS = 60_000;

const HUB_HINT =
	"The adapter keeps running and accepts advertisements from external gateways.";

/**
 * Scans with the Bluetooth adapter of this host. The Bluetooth driver (noble) runs in a
 * child process, so its native code is only loaded when the local scanner is used and
 * cannot bring down the adapter.
 */
export class NobleLocalTransport implements Transport {
	/**
	 * Prepares the scanner; the process is only started by start()
	 *
	 * @param ctx The adapter and where advertisements and gateway states go
	 * @param options What to scan for and with which HCI device
	 */
	public constructor(
		private readonly ctx: TransportContext,
		private readonly options: NobleLocalOptions,
	) {}

	public static readonly gateway: GatewayDescription = {
		id: "local",
		type: "local",
	};

	private scanProcess: ChildProcess | undefined;
	private restartTimer?: ioBroker.Timeout;
	private restartDelayMs = INITIAL_RESTART_DELAY_MS;
	/** Whether the scanner was stopped for good */
	private stopped = false;

	/** Starts the scanner process, unless the scanner was stopped for good */
	public start(): void {
		if (this.stopped || this.scanProcess || this.restartTimer) {
			return;
		}
		const { adapter } = this.ctx;

		const args: string[] = ["-s", ...this.options.services];
		if (this.options.manufacturerIds.length > 0) {
			args.push(
				"--manufacturerIds",
				...this.options.manufacturerIds.map(String),
			);
		}
		if (this.options.hciDevice) {
			args.push("-d", this.options.hciDevice.toString());
		}
		const interval = adapter.config.scanIntervalMinutes ?? 0;
		const duration = adapter.config.scanWindowSeconds ?? 10;
		if (Number.isInteger(interval) && interval > 0 && interval <= 1440) {
			if (
				Number.isInteger(duration) &&
				duration > 0 &&
				duration <= 3600 &&
				duration < interval * 60
			) {
				args.push(
					"--scanInterval",
					String(interval * 60),
					"--scanDuration",
					String(duration),
				);
			} else {
				adapter.log.warn(
					"The BLE scan window must be shorter than the scan interval. Scanning continuously.",
				);
			}
		}
		adapter.log.info("starting scanner process...");
		const startedAt = performance.now();
		const child = fork(path.join(__dirname, "..", "scanProcess"), args, {
			stdio: ["pipe", "pipe", "pipe", "ipc"],
		});
		this.scanProcess = child;
		child.once("exit", (code, signal) => {
			this.scanProcess = undefined;
			this.ctx.gateways.setConnected(NobleLocalTransport.gateway, false);
			if (this.stopped) {
				return;
			}
			const crashed = signal
				? NATIVE_CRASH_SIGNALS.has(signal)
				: code !== 0 && code !== ScanExitCodes.RequireNobleFailed;
			if (crashed) {
				this.restartAfterCrash(
					signal ?? String(code),
					performance.now() - startedAt,
				);
			}
		});
		// fork() reports a process that could not be started (e.g. EAGAIN) with "error", not "exit".
		// Unhandled, that event would stop the adapter, and gateways of other adapters with it.
		child.on("error", (error) => {
			adapter.log.error(`Scanner process: ${error.message}`);
			if (child.pid === undefined && this.scanProcess === child) {
				this.ctx.gateways.setConnected(
					NobleLocalTransport.gateway,
					false,
				);
				this.scanProcess = undefined;
			}
		});
		child.on(
			"message",
			getMessageReviver<ScanMessage>((message) => {
				if (!this.stopped && this.scanProcess === child) {
					this.handleMessage(message);
				}
			}),
		);
	}

	/** Stops the scanner for good and kills its process */
	public stop(): void {
		this.stopped = true;
		this.ctx.adapter.clearTimeout(this.restartTimer);
		this.restartTimer = undefined;
		try {
			this.scanProcess?.kill();
		} catch {
			// The process may have already exited.
		}
	}

	private restartAfterCrash(exitReason: string, uptimeMs: number): void {
		const { adapter } = this.ctx;
		if (uptimeMs >= STABLE_SCANNER_UPTIME_MS) {
			this.restartDelayMs = INITIAL_RESTART_DELAY_MS;
		}
		const delay = this.restartDelayMs;
		this.restartDelayMs = Math.min(delay * 2, MAX_RESTART_DELAY_MS);
		this.reportDriverState("driverError");
		adapter.log.warn(
			`Scanner process crashed (${exitReason}), restarting in ${delay / 1000} s.`,
		);
		this.restartTimer = adapter.setTimeout(() => {
			this.restartTimer = undefined;
			this.start();
		}, delay);
	}

	private reportDriverState(state: string): void {
		const { adapter } = this.ctx;
		adapter
			.setState("info.driverState", state, true)
			.catch((error: unknown) =>
				adapter.log.warn(
					`Could not update info.driverState: ${String(error)}`,
				),
			);
	}

	private handleMessage(message: ScanMessage): void {
		const { adapter, gateways } = this.ctx;
		switch (message.type) {
			case "connected":
				gateways.setConnected(NobleLocalTransport.gateway, true);
				break;
			case "disconnected":
				gateways.setConnected(NobleLocalTransport.gateway, false);
				break;
			case "discover":
				if (message.peripheral == null) {
					break;
				}
				gateways.recordAdvertisements(NobleLocalTransport.gateway, 1);
				this.ctx.onAdvertisement({
					...message.peripheral,
					gatewayId: NobleLocalTransport.gateway.id,
				});
				break;
			case "driverState":
				this.reportDriverState(message.driverState);
				break;
			case "error": // fall through
			case "fatal":
				this.handleError(message.error);
				break;
			case "log":
				adapter.log[message.level ?? "info"](message.message);
				break;
		}
	}

	/**
	 * A problem with the local Bluetooth adapter must not stop the adapter:
	 * it may still receive advertisements from external gateways.
	 *
	 * @param err The error the scanner process reported
	 */
	private handleError(err: Error): void {
		const { adapter } = this.ctx;
		switch (classifyScanError(err)) {
			case "no-hardware":
				adapter.log.error(
					`No compatible BLE 4.0 hardware found! The local Bluetooth adapter is not used. ${HUB_HINT}`,
				);
				this.stop();
				break;
			case "address-family-not-supported":
				adapter.log.error(
					`Unsupported Address Family (EAFNOSUPPORT). If ioBroker is running in a Docker container, make sure that the container uses host mode networking. The local Bluetooth adapter is not used. ${HUB_HINT}`,
				);
				this.stop();
				break;
			case "driver-missing":
				// The scanner process exits by itself in this case
				adapter.log.error(
					`The Bluetooth driver (noble) is not installed: ${err.message}. The local Bluetooth adapter is not used. ${HUB_HINT}`,
				);
				break;
			case "rebuild-required":
				if (adapter.supportsFeature?.("CONTROLLER_NPM_AUTO_REBUILD")) {
					adapter.log.error(
						"Terminating because a dependency requires a rebuild.",
					);
					this.stop();
					adapter.terminate?.("A dependency requires a rebuild.", 13);
					process.exit(13);
				}
				adapter.log.error(err.message);
				break;
			default:
				// This is something unexpected. We don't want to bring down the main process, so just log it
				adapter.log.error(err.message);
				break;
		}
	}
}
