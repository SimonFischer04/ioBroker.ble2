import { Socket } from "net";
import type { GatewayDescription } from "../gateways/gateway-registry";
import {
	getMessageReviver,
	type ScanMessage,
} from "../lib/scanProcessInterface";
import type { RemoteServer } from "./server-list";
import type { Transport, TransportContext } from "./transport";

const RECONNECT_INTERVAL_MS = 10000;
/** Longest incomplete message kept while waiting for its newline */
export const MAX_PENDING_FRAME = 1024 * 1024;

/**
 * Splits the text stream of a scan server into its messages, one per line. Keeps an incomplete
 * message until the rest arrives, but not beyond maxPending characters.
 */
export class FrameReader {
	public constructor(
		private readonly maxPending: number = MAX_PENDING_FRAME,
	) {}

	private pending = "";

	/**
	 * @param chunk Text as received
	 * @returns The complete lines, and whether the incomplete rest got too long
	 */
	public push(chunk: string): { lines: string[]; overflow: boolean } {
		this.pending += chunk;
		const lines = this.pending.split("\n");
		// The last part is the start of the next message
		this.pending = lines.pop() ?? "";
		const overflow = this.pending.length > this.maxPending;
		if (overflow) {
			this.pending = "";
		}
		return { lines, overflow };
	}
}

export interface NobleRemoteOptions {
	/**
	 * Whether the state of the Bluetooth driver on the server goes to info.driverState.
	 * Only one source may write that state, see main.ts.
	 */
	reportDriverState: boolean;
	/** How long to wait before connecting again after the connection was lost */
	reconnectIntervalMs?: number;
}

/**
 * Receives advertisements from a scanner process that runs on another host
 * and serves them via TCP (bin/blerp.js, setting "remoteServers").
 */
export class NobleRemoteTransport implements Transport {
	public constructor(
		private readonly ctx: TransportContext,
		private readonly server: RemoteServer,
		private readonly options: NobleRemoteOptions,
	) {
		this.gateway = { id: server.gatewayId, type: "server" };
	}

	public readonly gateway: GatewayDescription;

	private socket: Socket | undefined;
	private stopped = false;
	private reconnectTimer: NodeJS.Timeout | undefined;
	/** Whether the last attempt to connect failed, so a server that is down is not reported every 10 seconds */
	private failing = false;
	private lastDriverState: string | undefined;

	private get name(): string {
		return this.server.host.includes(":")
			? `[${this.server.host}]:${this.server.port}`
			: `${this.server.host}:${this.server.port}`;
	}

	public start(): void {
		this.stopped = false;
		this.connect();
	}

	private connect(): void {
		const { adapter, gateways } = this.ctx;
		const socket = new Socket();
		this.socket = socket;

		const reviver = getMessageReviver<ScanMessage>((message) =>
			this.handleMessage(message),
		);
		const frames = new FrameReader();
		let connected = false;
		// Characters split across two chunks are only decoded once complete
		socket.setEncoding("utf8");

		socket
			.on("close", () => {
				if (connected) {
					adapter.log.info(
						`Disconnected from BLE server ${this.name}`,
					);
				}
				gateways.setConnected(this.gateway, false);
				// Try again later, the server may be restarting
				if (!this.stopped) {
					this.reconnectTimer = setTimeout(
						() => this.connect(),
						this.options.reconnectIntervalMs ??
							RECONNECT_INTERVAL_MS,
					);
				}
			})
			.on("error", (e) => {
				const message = `Connection to BLE server ${this.name} failed: ${e.message}`;
				if (this.failing) {
					adapter.log.debug(message);
				} else {
					adapter.log.warn(
						`${message}. Trying again every ${Math.round(
							(this.options.reconnectIntervalMs ??
								RECONNECT_INTERVAL_MS) / 1000,
						)} seconds.`,
					);
					this.failing = true;
				}
			})
			.on("connect", () => {
				connected = true;
				this.failing = false;
				adapter.log.info(`Connected to BLE server ${this.name}`);
				// The gateway is active once the server reports that it scans ("connected", sent
				// to every new client) or delivers an advertisement, not with the TCP connection
			})
			.on("data", (data: string) => {
				// Each message ends with a newline. We might receive multiple messages at once,
				// and we might also receive incomplete messages.
				const { lines, overflow } = frames.push(data);
				if (overflow) {
					adapter.log.warn(
						`BLE server ${this.name} sent a message longer than ${MAX_PENDING_FRAME} characters, connecting again`,
					);
					socket.destroy();
					return;
				}
				for (const line of lines) {
					if (line === "") {
						continue;
					}
					try {
						const msg = JSON.parse(line);
						reviver(msg);
					} catch {
						adapter.log.debug(
							`Invalid message from BLE server ${this.name}: ${line}`,
						);
					}
				}
			});

		adapter.log.debug(`connecting to BLE server ${this.name}...`);
		socket.connect({ host: this.server.host, port: this.server.port });
	}

	public stop(): void {
		this.stopped = true;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
		}
		try {
			this.socket?.destroy();
		} catch {
			// The socket may have already been closed.
		}
	}

	private handleMessage(message: ScanMessage): void {
		const { adapter, gateways } = this.ctx;
		switch (message.type) {
			case "connected":
				gateways.setConnected(this.gateway, true);
				break;
			case "disconnected":
				gateways.setConnected(this.gateway, false);
				break;
			case "discover":
				if (message.peripheral == null) {
					break;
				}
				gateways.recordAdvertisements(this.gateway, 1);
				this.ctx.onAdvertisement({
					...message.peripheral,
					gatewayId: this.gateway.id,
				});
				break;
			case "driverState":
				if (message.driverState !== this.lastDriverState) {
					this.lastDriverState = message.driverState;
					adapter.log.info(
						`Bluetooth driver of BLE server ${this.name} is ${message.driverState}`,
					);
				}
				if (this.options.reportDriverState) {
					adapter.setState(
						"info.driverState",
						message.driverState,
						true,
					);
				}
				break;
			case "error": // fall through
			case "fatal":
				// A problem on the server must not stop the adapter
				adapter.log.error(
					`BLE server ${this.name}: ${message.error.message}`,
				);
				break;
			case "log":
				adapter.log[message.level ?? "info"](
					`BLE server ${this.name}: ${message.message}`,
				);
				break;
		}
	}
}
