import { Socket } from "net";
import type { GatewayDescription } from "../gateways/gateway-registry";
import {
	getMessageReviver,
	type ScanMessage,
} from "../lib/scanProcessInterface";
import type { RemoteServer } from "./server-list";
import type { Transport, TransportContext } from "./transport";

const RECONNECT_INTERVAL_MS = 10000;

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
		let receiveBuffer = "";
		let connected = false;

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
				gateways.setConnected(this.gateway, true);
			})
			.on("data", (data) => {
				// Each message ends with a newline. We might receive multiple messages at once,
				// and we might also receive incomplete messages.
				receiveBuffer += data.toString();
				let newlineIndex: number;
				while ((newlineIndex = receiveBuffer.indexOf("\n")) > -1) {
					const line = receiveBuffer.slice(0, newlineIndex);
					receiveBuffer = receiveBuffer.slice(newlineIndex + 1);
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
