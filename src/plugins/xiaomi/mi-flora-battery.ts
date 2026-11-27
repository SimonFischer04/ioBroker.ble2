import type { ConnectionManager } from "../../connections/connection-manager";
import type { PeripheralInfo } from "../../lib/advertisement";
import { normalizeAddress } from "../../lib/advertisement";
import { errorMessage, GatewayError } from "../../lib/gateway-error";
import { extendDevice, extendState } from "../../lib/iobroker-objects";
import { normalizeUuid } from "../../lib/uuid";

const batteryCharacteristic = "00001a02-0000-1000-8000-00805f9b34fb";
const oneDay = 24 * 60 * 60_000;
const retryDelay = 15 * 60_000;

/** Reads Mi Flora battery levels on configured plants through a connecting gateway. */
export class MiFloraBattery {
	private readonly nextRead = new Map<string, number>();
	private stopped = false;

	public constructor(
		private readonly adapter: ioBroker.Adapter,
		private readonly connections: Pick<
			ConnectionManager,
			"withSession" | "bestGateway"
		>,
		addresses: readonly string[],
	) {
		for (const address of addresses) {
			this.nextRead.set(address, 0);
		}
	}

	public observe(peripheral: PeripheralInfo): void {
		const address = normalizeAddress(peripheral.address);
		const due = address ? this.nextRead.get(address) : undefined;
		if (
			!address ||
			due == null ||
			this.stopped ||
			Date.now() < due ||
			!this.connections.bestGateway(address)
		) {
			return;
		}
		this.nextRead.set(address, Infinity);
		void this.read(address, peripheral).then(
			() => {
				if (!this.stopped) {
					this.nextRead.set(address, Date.now() + oneDay);
				}
			},
			(error: unknown) => {
				if (!this.stopped) {
					this.nextRead.set(address, Date.now() + retryDelay);
					this.adapter.log.warn(
						`Could not read Mi Flora battery for ${address}: ${errorMessage(error)}`,
					);
				}
			},
		);
	}

	public dispose(): void {
		this.stopped = true;
		this.nextRead.clear();
	}

	private async read(
		address: string,
		peripheral: PeripheralInfo,
	): Promise<void> {
		const battery = await this.connections.withSession(
			address,
			async (session) => {
				const services = await session.getServices();
				const service = services.find(({ characteristics }) =>
					characteristics.some(
						({ uuid }) =>
							normalizeUuid(uuid) === batteryCharacteristic,
					),
				);
				if (!service) {
					throw new GatewayError(
						"GATT_ERROR",
						"Mi Flora battery characteristic (1a02) is missing",
					);
				}
				const data = await session.read(
					service.uuid,
					batteryCharacteristic,
				);
				if (data.length === 0 || data[0] > 100) {
					throw new GatewayError(
						"GATT_ERROR",
						"Invalid Mi Flora battery reading",
					);
				}
				return data[0];
			},
		);
		if (this.stopped) {
			return;
		}
		await extendDevice(address, peripheral, {
			common: { name: peripheral.advertisement.localName || "Mi Flora" },
		});
		const id = `${address}.battery`;
		await extendState(id, {
			id: "battery",
			common: {
				name: "Battery",
				role: "value.battery",
				type: "number",
				unit: "%",
				read: true,
				write: false,
			},
		});
		if (!this.stopped) {
			await this.adapter.setStateChangedAsync(id, battery, true);
		}
	}
}
