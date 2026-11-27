import type { GattLink } from "../connections/gatt-link";
import { decodeBase64 } from "../lib/base64";
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

/**
 * A connection to a device through a gateway another adapter provides. The commands go to that
 * adapter as gatt:* messages.
 */
export class RemoteGattLink implements GattLink {
	/**
	 * Wraps a connection the gateway has already opened
	 *
	 * @param sender Sends the gatt:* messages to the instance
	 * @param log Logs failed disconnects
	 * @param gatewayId Full ID of the gateway, e.g. "esphome.0:proxy-og"
	 * @param instance The instance that owns the gateway, e.g. "esphome.0"
	 * @param localGatewayId ID of the gateway within that instance, e.g. "proxy-og"
	 * @param address MAC address of the connected device
	 * @param mtu The MTU the gateway negotiated
	 * @param onEnd Called once when the link ends, however that happens
	 */
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
	 * @param command The gatt:* command
	 * @param payload Sent together with the gateway ID and address of the link
	 * @param timeoutMs How long to wait for the answer
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

	/** Sends gatt:getServices and checks that the answer contains a list of services */
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

	/**
	 * Sends gatt:read and decodes the base64 value of the answer
	 *
	 * @param handle Handle of the characteristic or descriptor
	 */
	public async read(handle: number): Promise<Buffer> {
		const result = await this.request<GattReadResult>(
			GattCommands.read,
			{ handle },
			GATT_TIMEOUTS_MS.read,
		);
		const data = decodeBase64(result?.data);
		if (!data) {
			throw new GatewayError(
				"GATT_ERROR",
				`Unexpected answer to ${GattCommands.read}`,
			);
		}
		return data;
	}

	/**
	 * Sends gatt:write with the value base64 encoded
	 *
	 * @param handle Handle of the characteristic or descriptor
	 * @param data The value to write
	 * @param withResponse Whether the device must confirm the write
	 */
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

	/**
	 * Sends gatt:writeSequence. Only for gateways with the feature "writeSequence".
	 *
	 * @param handle Handle of the characteristic
	 * @param data The values to write, in this order
	 * @param withResponse Whether the device must confirm each write
	 * @param readAfter Whether to read the handle after the last write
	 */
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
		const value = decodeBase64(result?.data);
		if (!value) {
			throw new GatewayError(
				"GATT_ERROR",
				`Invalid answer to ${GattCommands.writeSequence}`,
			);
		}
		return value;
	}

	/**
	 * Sends gatt:subscribe. The listener is registered first, so no notification is missed,
	 * and removed again if the subscription fails.
	 *
	 * @param handle Handle of the characteristic
	 * @param listener Called with the value of every notification
	 */
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

	/** Ends the link at once and tells the gateway; if that fails, it is only logged */
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

	/**
	 * Registers a listener for when the link ends without disconnect() being called
	 *
	 * @param listener Called once
	 */
	public onDisconnect(listener: () => void): void {
		this.disconnectListeners.push(listener);
	}

	/**
	 * The gateway delivered a notification for this link
	 *
	 * @param handle Handle of the characteristic
	 * @param data The value
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
