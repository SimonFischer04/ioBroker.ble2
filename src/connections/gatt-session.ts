import { GatewayError } from "../lib/gateway-error";
import type {
	GattCharacteristicInfo,
	GattServiceInfo,
} from "../lib/gateway-protocol";
import { normalizeUuid } from "../lib/uuid";
import type { GattLink } from "./gatt-link";

/**
 * The use of a link by one job, from connecting to disconnecting. Works with UUIDs instead of
 * handles and does not tell which gateway the connection goes through.
 */
export class GattSession {
	public constructor(private readonly link: GattLink) {
		this.address = link.address;
		this.gatewayId = link.gatewayId;
		this.mtu = link.mtu;
		link.onDisconnect(() => {
			this._closed = true;
		});
	}

	public readonly address: string;
	public readonly gatewayId: string;
	public readonly mtu: number;

	private _closed = false;
	private disconnected = false;
	private services: Promise<GattServiceInfo[]> | undefined;

	/** Whether the session can still be used */
	public get closed(): boolean {
		return this._closed;
	}

	private ensureOpen(): void {
		if (this._closed) {
			throw new GatewayError(
				"NOT_CONNECTED",
				`The connection to ${this.address} is closed`,
			);
		}
	}

	/** The services of the device. Fetched once per session. */
	public async getServices(): Promise<GattServiceInfo[]> {
		this.ensureOpen();
		if (!this.services) {
			this.services = this.link.getServices();
			// A failed attempt may be repeated
			this.services.catch(() => {
				this.services = undefined;
			});
		}
		return this.services;
	}

	private async findCharacteristic(
		service: string,
		characteristic: string,
	): Promise<GattCharacteristicInfo> {
		this.ensureOpen();
		const serviceUuid = normalizeUuid(service);
		const characteristicUuid = normalizeUuid(characteristic);
		if (!serviceUuid) {
			throw new GatewayError(
				"INVALID_PAYLOAD",
				`"${String(service)}" is not a UUID`,
			);
		}
		if (!characteristicUuid) {
			throw new GatewayError(
				"INVALID_PAYLOAD",
				`"${String(characteristic)}" is not a UUID`,
			);
		}
		const services = await this.getServices();
		const found = services
			.find((s) => s.uuid === serviceUuid)
			?.characteristics.find((c) => c.uuid === characteristicUuid);
		if (!found) {
			throw new GatewayError(
				"GATT_ERROR",
				`Characteristic ${characteristicUuid} of service ${serviceUuid} not found`,
			);
		}
		return found;
	}

	public async read(
		service: string,
		characteristic: string,
	): Promise<Buffer> {
		const { handle } = await this.findCharacteristic(
			service,
			characteristic,
		);
		this.ensureOpen();
		return this.link.read(handle);
	}

	public async write(
		service: string,
		characteristic: string,
		data: Buffer,
		withResponse: boolean = true,
	): Promise<void> {
		const { handle } = await this.findCharacteristic(
			service,
			characteristic,
		);
		this.ensureOpen();
		return this.link.write(handle, data, withResponse);
	}

	public async subscribe(
		service: string,
		characteristic: string,
		listener: (data: Buffer) => void,
	): Promise<void> {
		const { handle } = await this.findCharacteristic(
			service,
			characteristic,
		);
		this.ensureOpen();
		return this.link.subscribe(handle, listener);
	}

	/** Ends the connection. Can be called several times. */
	public async close(): Promise<void> {
		this._closed = true;
		if (this.disconnected) return;
		this.disconnected = true;
		await this.link.disconnect();
	}
}
