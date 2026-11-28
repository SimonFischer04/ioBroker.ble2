import { fork, type ChildProcess } from "child_process";
import * as path from "path";
import type { GatewayDescription } from "../gateways/gateway-registry";
import {
	ScanExitCodes,
	getMessageReviver,
	type ScanMessage,
} from "../lib/scanProcessInterface";
import { ScannerIdleMonitor } from "../lib/scanner-idle-monitor";
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
	private idleMonitor?: ScannerIdleMonitor;
	/** Whether the scanner was stopped for good */
	private stopped = false;

	/** Starts the scanner process, unless the scanner was stopped for good */
	public start(): void {
		if (this.stopped || this.scanProcess) {
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
		const idleMinutes = adapter.config.scannerIdleRestartMinutes ?? 0;
		const recoveryEnabled =
			Number.isInteger(idleMinutes) &&
			idleMinutes > 0 &&
			idleMinutes <= 1440;
		if (recoveryEnabled) {
			args.push("--reportScanActivity");
		}
		adapter.log.info("starting scanner process...");
		const child = fork(path.join(__dirname, "..", "scanProcess"), args, {
			stdio: ["pipe", "pipe", "pipe", "ipc"],
		});
		this.scanProcess = child;
		let restartRequested = false;
		if (recoveryEnabled) {
			this.idleMonitor = new ScannerIdleMonitor(
				adapter,
				idleMinutes * 60000,
				() => {
					if (this.stopped || this.scanProcess !== child) {
						return;
					}
					adapter.log.warn(
						"No Bluetooth packets during active scanning. Restarting the local scanner.",
					);
					restartRequested = child.kill();
				},
			);
		}
		child.once("exit", (code, signal) => {
			this.idleMonitor?.stop();
			this.idleMonitor = undefined;
			this.scanProcess = undefined;
			this.ctx.gateways.setConnected(NobleLocalTransport.gateway, false);
			if (this.stopped) {
				return;
			}
			const crashed =
				!signal &&
				code !== 0 &&
				code !== ScanExitCodes.RequireNobleFailed;
			if (crashed || restartRequested) {
				if (!restartRequested) {
					adapter.log.warn("scanner process crashed, restarting...");
				}
				setImmediate(() => this.start());
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
				this.idleMonitor?.stop();
				this.idleMonitor = undefined;
				this.scanProcess = undefined;
			}
		});
		child.on(
			"message",
			getMessageReviver<ScanMessage>((message) => {
				if (
					!this.stopped &&
					!restartRequested &&
					this.scanProcess === child
				) {
					this.handleMessage(message);
				}
			}),
		);
	}

	/** Stops the scanner for good and kills its process */
	public stop(): void {
		this.stopped = true;
		this.idleMonitor?.stop();
		try {
			this.scanProcess?.kill();
		} catch {
			// The process may have already exited.
		}
	}

	private handleMessage(message: ScanMessage): void {
		const { adapter, gateways } = this.ctx;
		switch (message.type) {
			case "connected":
				this.idleMonitor?.startWindow();
				gateways.setConnected(NobleLocalTransport.gateway, true);
				break;
			case "disconnected":
				this.idleMonitor?.endWindow();
				gateways.setConnected(NobleLocalTransport.gateway, false);
				break;
			case "scanActivity":
				this.idleMonitor?.packet();
				break;
			case "discover":
				this.idleMonitor?.packet();
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
				adapter
					.setState("info.driverState", message.driverState, true)
					.catch((e) =>
						adapter.log.warn(
							`Could not update info.driverState: ${(e as Error).message}`,
						),
					);
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
