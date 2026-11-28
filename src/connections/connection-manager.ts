import type { DeviceRegistry } from "../devices/device-registry";
import type { GatewayRegistry } from "../gateways/gateway-registry";
import { normalizeAddress } from "../lib/advertisement";
import { GatewayError } from "../lib/gateway-error";
import type { GatewayFeature } from "../lib/gateway-protocol";
import type { GattLink, GattLinkProvider } from "./gatt-link";
import { GattSession } from "./gatt-session";

/** Options for one job run with ConnectionManager.withSession() */
export interface SessionOptions {
	/** High priority jobs for a device run before normal ones. Default: "normal" */
	priority?: "normal" | "high";
	/** After this time the session is closed and the job fails with TIMEOUT. Default: 60000 */
	timeoutMs?: number;
	/**
	 * Full IDs of the gateways to try, in this order. Only these are used, even if they have never
	 * reported the device. Default: candidates(address).
	 */
	gateways?: string[];
	/** Override the address type when it is known by the caller. */
	addressType?: "public" | "random";
}

/** A gateway that can connect to a device, see ConnectionManager.candidates() */
export interface GatewayCandidate {
	/** Full ID of the gateway */
	gatewayId: string;
	/** Signal strength the gateway receives the device with, in dBm */
	rssi: number;
	/** What the gateway supports beyond the basic commands */
	features: readonly GatewayFeature[];
}

/** What the ConnectionManager needs from the adapter, injected so tests can replace it */
export interface ConnectionManagerContext {
	/** Where connection attempts and failures are logged */
	log: Pick<ioBroker.Logger, "debug" | "info" | "warn">;
	/** Tells which gateways receive a device and its address type */
	devices: DeviceRegistry;
	/** Tells which gateways are connected and what they support */
	gateways: GatewayRegistry;
	/** Opens the links through the gateways */
	provider: GattLinkProvider;
	/** Starts a timer, the adapter's own so it is cleared when the adapter stops */
	setTimeout(callback: () => void, ms: number): unknown;
	/** Stops a timer started with setTimeout */
	clearTimeout(timer: any): void;
}

const DEFAULT_TIMEOUT_MS = 60000;
/** How long to wait for a session to close before the next job for the device starts */
const CLOSE_TIMEOUT_MS = 10000;

interface Job {
	run: (session: GattSession) => Promise<unknown>;
	options: SessionOptions;
	resolve: (value: any) => void;
	reject: (reason: unknown) => void;
}

interface DeviceQueue {
	running: boolean;
	/** The session of the running job, once connected */
	session?: GattSession;
	waiting: Job[];
}

function stoppingError(): GatewayError {
	return new GatewayError("NOT_CONNECTED", "The adapter is stopping");
}

/**
 * The only place that opens connections to devices. Runs one job per device at a time, picks the
 * gateway and makes sure the connection is closed again, whatever happens.
 */
export class ConnectionManager {
	/** @param ctx What the manager needs from the adapter */
	public constructor(private readonly ctx: ConnectionManagerContext) {}

	private readonly queues = new Map<string, DeviceQueue>();
	private disposed = false;

	/**
	 * Connects to the device, runs the job and disconnects again, whatever happens
	 *
	 * @param address MAC address of the device
	 * @param job Runs with the open session, its result is returned
	 * @param options How the gateway is picked and how long the job may take
	 */
	public withSession<T>(
		address: string,
		job: (session: GattSession) => Promise<T>,
		options: SessionOptions = {},
	): Promise<T> {
		const normalized = normalizeAddress(address);
		if (!normalized) {
			return Promise.reject(
				new GatewayError(
					"INVALID_PAYLOAD",
					`"${String(address)}" is not a MAC address`,
				),
			);
		}
		if (this.disposed) {
			return Promise.reject(stoppingError());
		}

		return new Promise<T>((resolve, reject) => {
			let queue = this.queues.get(normalized);
			if (!queue) {
				queue = { running: false, waiting: [] };
				this.queues.set(normalized, queue);
			}
			queue.waiting.push({ run: job, options, resolve, reject });
			this.pump(normalized);
		});
	}

	/** Closes all sessions and fails all waiting jobs. To be called when the adapter stops. */
	public dispose(): void {
		this.disposed = true;
		for (const queue of this.queues.values()) {
			for (const job of queue.waiting.splice(0)) {
				job.reject(stoppingError());
			}
			void queue.session?.close().catch(() => {});
		}
	}

	/**
	 * Starts the next waiting job for the device, if none is running
	 *
	 * @param address Normalized MAC address of the device
	 */
	private pump(address: string): void {
		const queue = this.queues.get(address);
		if (!queue || queue.running) {
			return;
		}
		if (queue.waiting.length === 0) {
			this.queues.delete(address);
			return;
		}
		let index = queue.waiting.findIndex(
			(job) => job.options.priority === "high",
		);
		if (index === -1) {
			index = 0;
		}
		const [job] = queue.waiting.splice(index, 1);
		queue.running = true;
		void this.run(address, queue, job);
	}

	/**
	 * The gateways that receive the device and can connect now, strongest signal first. A session
	 * without SessionOptions.gateways tries them in this order. Callers with special needs (a
	 * feature, a minimum signal) filter the list and pass the result as SessionOptions.gateways.
	 *
	 * @param address MAC address of the device
	 */
	public candidates(address: string): GatewayCandidate[] {
		const normalized = normalizeAddress(address);
		if (!normalized) {
			return [];
		}
		return this.ctx.devices
			.getReceivers(normalized)
			.flatMap(({ gatewayId, rssi }) => {
				const gateway = this.connectable(gatewayId);
				return gateway
					? [{ gatewayId, rssi, features: gateway.features }]
					: [];
			});
	}

	/**
	 * The gateway, if it is online, can connect and has a free slot
	 *
	 * @param gatewayId Full ID of the gateway
	 */
	private connectable(
		gatewayId: string,
	): { features: readonly GatewayFeature[] } | undefined {
		const gateway = this.ctx.gateways.get(gatewayId);
		return gateway?.connected === true &&
			gateway.connect === true &&
			gateway.freeSlots !== 0
			? gateway
			: undefined;
	}

	/**
	 * The newest signal strength a gateway measured for the device and how old it is, whether or
	 * not the gateway can connect right now. undefined if it never received the device.
	 *
	 * @param address MAC address of the device
	 * @param gatewayId Full ID of the gateway
	 */
	public reception(
		address: string,
		gatewayId: string,
	): { rssi: number; ageMs: number } | undefined {
		const normalized = normalizeAddress(address);
		return normalized
			? this.ctx.devices.getReception(normalized, gatewayId)
			: undefined;
	}

	/**
	 * Opens a link through the first candidate that connects
	 *
	 * @param address Normalized MAC address of the device
	 * @param options The options of the job
	 * @param expired Tells whether the job has expired: then no further gateway is tried
	 */
	private async connect(
		address: string,
		options: SessionOptions,
		expired: () => boolean,
	): Promise<GattLink> {
		const candidates =
			options.gateways?.filter((id) => this.connectable(id)) ??
			this.candidates(address).map(({ gatewayId }) => gatewayId);
		if (candidates.length === 0) {
			throw new GatewayError(
				"NO_GATEWAY",
				options.gateways
					? `None of the gateways ${options.gateways.join(", ") || "(none)"} can connect`
					: `No gateway that can connect receives ${address}`,
			);
		}
		const addressType =
			options.addressType ?? this.ctx.devices.getAddressType(address);
		let lastError: unknown;
		for (const gatewayId of candidates) {
			if (expired()) {
				break;
			}
			try {
				return await this.ctx.provider.connect(
					gatewayId,
					address,
					addressType,
				);
			} catch (e) {
				lastError = e;
				this.ctx.log.debug(
					`Could not connect to ${address} through ${gatewayId}: ${
						(e as Error)?.message ?? String(e)
					}`,
				);
			}
		}
		throw lastError;
	}

	private async run(
		address: string,
		queue: DeviceQueue,
		job: Job,
	): Promise<void> {
		const timeoutMs = job.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		/** Set when the time is up or the adapter stops: whatever comes later is thrown away */
		let aborted = false;
		let timer: unknown;

		const timeout = new Promise<never>((_, reject) => {
			timer = this.ctx.setTimeout(() => {
				aborted = true;
				reject(
					new GatewayError(
						"TIMEOUT",
						`Session with ${address} took longer than ${timeoutMs} ms`,
					),
				);
			}, timeoutMs);
		});

		const connected = (async () => {
			const session = new GattSession(
				await this.connect(
					address,
					job.options,
					() => aborted || this.disposed,
				),
			);
			if (aborted || this.disposed) {
				await this.closeSession(session);
				throw this.disposed
					? stoppingError()
					: new GatewayError("TIMEOUT", "");
			}
			queue.session = session;
			return session;
		})();
		const work = connected.then((session) => job.run(session));
		// The result of an aborted job is not of interest any more
		work.catch(() => {});

		try {
			job.resolve(await Promise.race([work, timeout]));
		} catch (e) {
			job.reject(e);
		} finally {
			aborted = true;
			this.ctx.clearTimeout(timer);
			// A connection attempt that is still running would replace or close the link of the
			// next job for the device. It ends by itself (the gatt:connect timeout) and a late link
			// is closed right away, so the next job waits for that.
			if (!queue.session) {
				await connected.catch(() => {});
			}
			const session = queue.session;
			queue.session = undefined;
			if (session) {
				await this.closeSession(session);
			}
			queue.running = false;
			this.pump(address);
		}
	}

	/**
	 * Closes a session, waiting at most CLOSE_TIMEOUT_MS
	 *
	 * @param session The session to close
	 */
	private async closeSession(session: GattSession): Promise<void> {
		let timer: unknown;
		await Promise.race([
			session.close().catch(() => {}),
			new Promise<void>((resolve) => {
				timer = this.ctx.setTimeout(resolve, CLOSE_TIMEOUT_MS);
			}),
		]);
		this.ctx.clearTimeout(timer);
	}
}
