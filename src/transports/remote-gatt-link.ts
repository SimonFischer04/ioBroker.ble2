import type { GattLink } from "../connections/gatt-link";
import { GatewayError, normalizeError } from "../lib/gateway-error";
import {
	GattCommands,
	MAX_WRITE_SEQUENCE_LENGTH,
	type GattGetServicesResult,
	type GattReadResult,
	type GattServiceInfo,
	type GattWriteSequenceResult,
} from "../lib/gateway-protocol";
import { sendRequest, type RequestSender } from "../lib/send-request";

/** Timeouts of the gatt:* commands, see the specification of phase 2, A2 */
export const GATT_TIMEOUTS_MS = {
	connect: 25000,
	disconnect: 10000,
	getServices: 15000,
	read: 10000,
	write: 10000,
	subscribe: 10000,
	writeSequence: 30000,
} as const;

const BASE64_REGEX =
	/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * A connection to a device through a gateway another adapter provides. The commands go to that
 * adapter as gatt:* messages.
 */
export class RemoteGattLink implements GattLink {
	public constructor(
		private readonly sender: RequestSender,
		private readonly log: Pick<ioBroker.Logger, "debug">,
		/** Full ID of the gateway, e.g. "esphome.0:proxy-og" */
		public readonly gatewayId: string,
		/** The instance that owns the gateway, e.g. "esphome.0" */
		private readonly instance: string,
		/** ID of the gateway within that instance, e.g. "proxy-og" */
		private readonly localGatewayId: string,
		public readonly address: string,
		public readonly mtu: number,
		/** Called once when the link ends, however that happens */
		private readonly onEnd: () => void,
	) {}

	private ended = false;
	private readonly pending = new Set<(error: GatewayError) => void>();
	private readonly listeners = new Map<number, (data: Buffer) => void>();
	private disconnectListeners: (() => void)[] = [];

	private notConnected(): GatewayError {
		return new GatewayError(
			"NOT_CONNECTED",
			`The connection to ${this.address} through ${this.gatewayId} has ended`,
		);
	}

	/**
	 * Sends a command for this link. Rejects at once when the link ends.
	 *
	 * @param command
	 * @param payload
	 * @param timeoutMs
	 */
	private request<T>(
		command: string,
		payload: Record<string, unknown>,
		timeoutMs: number,
	): Promise<T> {
		if (this.ended) {
			return Promise.reject(this.notConnected());
		}
		return new Promise<T>((resolve, reject) => {
			const abort = (error: GatewayError): void => reject(error);
			this.pending.add(abort);
			sendRequest<T>(
				this.sender,
				this.instance,
				command,
				{
					gatewayId: this.localGatewayId,
					address: this.address,
					...payload,
				},
				timeoutMs,
			).then(
				(result) => {
					if (this.pending.delete(abort)) {
						resolve(result);
					}
				},
				(error) => {
					if (this.pending.delete(abort)) {
						reject(normalizeError(error));
					}
				},
			);
		});
	}

	public async getServices(): Promise<GattServiceInfo[]> {
		const result = await this.request<GattGetServicesResult>(
			GattCommands.getServices,
			{},
			GATT_TIMEOUTS_MS.getServices,
		);
		if (!Array.isArray(result?.services)) {
			throw new GatewayError(
				"GATT_ERROR",
				`Unexpected answer to ${GattCommands.getServices}`,
			);
		}
		return result.services;
	}

	public async read(handle: number): Promise<Buffer> {
		const result = await this.request<GattReadResult>(
			GattCommands.read,
			{ handle },
			GATT_TIMEOUTS_MS.read,
		);
		if (typeof result?.data !== "string") {
			throw new GatewayError(
				"GATT_ERROR",
				`Unexpected answer to ${GattCommands.read}`,
			);
		}
		return Buffer.from(result.data, "base64");
	}

	public async write(
		handle: number,
		data: Buffer,
		withResponse: boolean,
	): Promise<void> {
		await this.request(
			GattCommands.write,
			{ handle, data: data.toString("base64"), withResponse },
			GATT_TIMEOUTS_MS.write,
		);
	}

	public async writeSequence(
		handle: number,
		data: Buffer[],
		withResponse: boolean,
		readAfter: boolean,
	): Promise<Buffer | undefined> {
		if (data.length === 0 || data.length > MAX_WRITE_SEQUENCE_LENGTH) {
			throw new GatewayError(
				"INVALID_PAYLOAD",
				`A write sequence has 1 to ${MAX_WRITE_SEQUENCE_LENGTH} entries, not ${data.length}`,
			);
		}
		const result = await this.request<GattWriteSequenceResult>(
			GattCommands.writeSequence,
			{
				handle,
				data: data.map((d) => d.toString("base64")),
				withResponse,
				readAfter,
			},
			GATT_TIMEOUTS_MS.writeSequence,
		);
		if (!readAfter) {
			return undefined;
		}
		if (
			typeof result?.data !== "string" ||
			!BASE64_REGEX.test(result.data)
		) {
			throw new GatewayError(
				"GATT_ERROR",
				`Invalid answer to ${GattCommands.writeSequence}`,
			);
		}
		return Buffer.from(result.data, "base64");
	}

	public async subscribe(
		handle: number,
		listener: (data: Buffer) => void,
	): Promise<void> {
		if (this.ended) {
			throw this.notConnected();
		}
		this.listeners.set(handle, listener);
		try {
			await this.request(
				GattCommands.subscribe,
				{ handle },
				GATT_TIMEOUTS_MS.subscribe,
			);
		} catch (e) {
			if (this.listeners.get(handle) === listener) {
				this.listeners.delete(handle);
			}
			throw e;
		}
	}

	public async disconnect(): Promise<void> {
		if (this.ended) {
			return;
		}
		this.finish();
		try {
			await sendRequest(
				this.sender,
				this.instance,
				GattCommands.disconnect,
				{ gatewayId: this.localGatewayId, address: this.address },
				GATT_TIMEOUTS_MS.disconnect,
			);
		} catch (e) {
			this.log.debug(
				`Disconnecting ${this.address} through ${this.gatewayId} failed: ${
					(e as Error).message
				}`,
			);
		}
	}

	public onDisconnect(listener: () => void): void {
		this.disconnectListeners.push(listener);
	}

	/**
	 * The gateway delivered a notification for this link
	 *
	 * @param handle
	 * @param data
	 */
	public handleNotification(handle: number, data: Buffer): void {
		this.listeners.get(handle)?.(data);
	}

	/** The connection ended without disconnect() being called: the gateway reported it or went offline */
	public handleEnded(): void {
		if (this.ended) {
			return;
		}
		this.finish();
		for (const listener of this.disconnectListeners.splice(0)) {
			try {
				listener();
			} catch {
				// A listener must not keep the others from running
			}
		}
	}

	private finish(): void {
		this.ended = true;
		this.listeners.clear();
		const error = this.notConnected();
		for (const abort of [...this.pending]) {
			abort(error);
		}
		this.pending.clear();
		this.onEnd();
	}
}
