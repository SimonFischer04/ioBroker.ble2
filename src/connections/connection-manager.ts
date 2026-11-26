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
	/** Full ID of the gateway to try first */
	preferGateway?: string;
	/** Only gateways with this feature are used */
	requireFeature?: GatewayFeature;
	/** Only gateways that receive the device at least this well (dBm) are used, also as fallback */
	minRssi?: number;
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
	 * The gateway a session would try first, with the signal strength it receives the device with
	 *
	 * @param address MAC address of the device
	 * @param requireFeature Only gateways with this feature are considered
	 */
	public bestGateway(
		address: string,
		requireFeature?: GatewayFeature,
	): { gatewayId: string; rssi: number } | undefined {
		const normalized = normalizeAddress(address);
		if (!normalized) {
			return undefined;
		}
		const [gatewayId] = this.getCandidates(
			normalized,
			undefined,
			requireFeature,
		);
		if (!gatewayId) {
			return undefined;
		}
		const receiver = this.ctx.devices
			.getReceivers(normalized)
			.find((r) => r.gatewayId === gatewayId);
		return receiver && { gatewayId, rssi: receiver.rssi };
	}

	/**
	 * The gateways to try, best first
	 *
	 * @param address Normalized MAC address of the device
	 * @param preferGateway Full ID of the gateway to put first, if it qualifies
	 * @param requireFeature Only gateways with this feature are used
	 * @param minRssi Only gateways that receive the device at least this well (dBm) are used
	 */
	private getCandidates(
		address: string,
		preferGateway?: string,
		requireFeature?: GatewayFeature,
		minRssi?: number,
	): string[] {
		const candidates = this.ctx.devices
			.getReceivers(address)
			.filter((r) => minRssi === undefined || r.rssi >= minRssi)
			.map((r) => r.gatewayId)
			.filter((id) => {
				const gateway = this.ctx.gateways.get(id);
				return (
					gateway?.connected === true &&
					gateway.connect === true &&
					gateway.freeSlots !== 0 &&
					(!requireFeature ||
						gateway.features.includes(requireFeature))
				);
			});
		if (preferGateway && candidates.includes(preferGateway)) {
			candidates.splice(candidates.indexOf(preferGateway), 1);
			candidates.unshift(preferGateway);
		}
		return candidates;
	}

	private async connect(
		address: string,
		options: SessionOptions,
	): Promise<GattLink> {
		const candidates = this.getCandidates(
			address,
			options.preferGateway,
			options.requireFeature,
			options.minRssi,
		);
		if (candidates.length === 0) {
			throw new GatewayError(
				"NO_GATEWAY",
				(options.requireFeature
					? `No gateway with ${options.requireFeature} receives ${address}`
					: `No gateway that can connect receives ${address}`) +
					(options.minRssi === undefined
						? ""
						: ` with at least ${options.minRssi} dBm`),
			);
		}
		const addressType = this.ctx.devices.getAddressType(address);
		let lastError: unknown;
		for (const gatewayId of candidates) {
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

		const work = (async () => {
			const link = await this.connect(address, job.options);
			const session = new GattSession(link);
			if (aborted || this.disposed) {
				await session.close().catch(() => {});
				throw this.disposed
					? stoppingError()
					: new GatewayError("TIMEOUT", "");
			}
			queue.session = session;
			return job.run(session);
		})();
		// The result of an aborted job is not of interest any more
		work.catch(() => {});

		try {
			job.resolve(await Promise.race([work, timeout]));
		} catch (e) {
			job.reject(e);
		} finally {
			aborted = true;
			this.ctx.clearTimeout(timer);
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
