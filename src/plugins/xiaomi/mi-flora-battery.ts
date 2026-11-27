import type { ConnectionManager } from "../../connections/connection-manager";
import { DevicePoller } from "../../connections/device-poller";
import type { PeripheralInfo } from "../../lib/advertisement";
import { GatewayError } from "../../lib/gateway-error";
import { extendDevice, extendState } from "../../lib/iobroker-objects";

const batteryCharacteristic = "00001a02-0000-1000-8000-00805f9b34fb";
const oneDay = 24 * 60 * 60_000;
const retryDelay = 15 * 60_000;

/** Reads Mi Flora battery levels on configured plants through a connecting gateway. */
export class MiFloraBattery {
	private readonly poller: DevicePoller;

	public constructor(
		private readonly adapter: ioBroker.Adapter,
		private readonly connections: Pick<
			ConnectionManager,
			"withSession" | "candidates"
		>,
		addresses: readonly string[],
	) {
		this.poller = new DevicePoller(
			adapter.log,
			connections,
			addresses,
			{
				intervalMs: oneDay,
				retryMs: retryDelay,
				what: "read the Mi Flora battery of",
			},
			(address, peripheral) => this.read(address, peripheral),
		);
	}

	/**
	 * To be called for every received advertisement
	 *
	 * @param peripheral The advertisement
	 */
	public observe(peripheral: PeripheralInfo): void {
		this.poller.observe(peripheral);
	}

	/** Stops polling */
	public dispose(): void {
		this.poller.dispose();
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
						({ uuid }) => uuid === batteryCharacteristic,
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
		if (this.poller.disposed) {
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
		if (!this.poller.disposed) {
			await this.adapter.setStateChangedAsync(id, battery, true);
		}
	}
}
