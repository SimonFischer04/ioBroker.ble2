import type { ConnectionManager } from "../../connections/connection-manager";
import { DevicePoller } from "../../connections/device-poller";
import type { PeripheralInfo } from "../../lib/advertisement";
import { GatewayError } from "../../lib/gateway-error";
import { extendDevice, extendState } from "../../lib/iobroker-objects";
import { normalizeUuid } from "../../lib/uuid";

const liveService = "39e1fa00-84a8-11e2-afba-0002a5d5c51b";
const batteryService = "0000180f-0000-1000-8000-00805f9b34fb";
const sampleIntervalMs = 15 * 60_000;
const retryMs = 60_000;

const fields = [
	{
		id: "moisture",
		service: liveService,
		uuid: "39e1fa09-84a8-11e2-afba-0002a5d5c51b",
		name: "Soil moisture",
		role: "value",
		unit: "%",
		min: 0,
		max: 100,
	},
	{
		id: "temperature",
		service: liveService,
		uuid: "39e1fa0a-84a8-11e2-afba-0002a5d5c51b",
		name: "Air temperature",
		role: "value.temperature",
		unit: "°C",
		min: -40,
		max: 85,
	},
	{
		id: "sunlight",
		service: liveService,
		uuid: "39e1fa0b-84a8-11e2-afba-0002a5d5c51b",
		name: "Daily light integral",
		role: "value",
		unit: "mol/m²/d",
		min: 0,
		max: Infinity,
	},
	{
		id: "battery",
		service: batteryService,
		uuid: "00002a19-0000-1000-8000-00805f9b34fb",
		name: "Battery",
		role: "value.battery",
		unit: "%",
		min: 0,
		max: 100,
	},
] as const;

/** Polls calibrated Parrot Flower Power readings through a connecting gateway. */
export class FlowerPower {
	private readonly poller: DevicePoller;

	public constructor(
		private readonly adapter: ioBroker.Adapter,
		private readonly connections: Pick<
			ConnectionManager,
			"withSession" | "bestGateway"
		>,
		addresses: readonly string[],
	) {
		this.poller = new DevicePoller(
			adapter.log,
			connections,
			addresses,
			{
				intervalMs: sampleIntervalMs,
				retryMs: retryMs,
				what: "poll the Flower Power at",
			},
			(address, peripheral) => this.poll(address, peripheral),
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

	private async poll(
		address: string,
		peripheral: PeripheralInfo,
	): Promise<void> {
		const readings = await this.connections.withSession(
			address,
			async (session) => {
				const services = await session.getServices();
				if (
					!services.some(
						({ uuid }) => normalizeUuid(uuid) === liveService,
					)
				) {
					throw new GatewayError(
						"GATT_ERROR",
						"The Flower Power Live service was not found",
					);
				}
				const readings: {
					field: (typeof fields)[number];
					value: number;
				}[] = [];
				for (const field of fields) {
					const service = services.find(
						({ uuid }) => normalizeUuid(uuid) === field.service,
					);
					if (
						!service?.characteristics.some(
							({ uuid, properties }) =>
								normalizeUuid(uuid) === field.uuid &&
								(properties & 0x02) !== 0,
						)
					) {
						continue;
					}
					const data = await session.read(field.service, field.uuid);
					const battery = field.id === "battery";
					if (data.length !== (battery ? 1 : 4)) {
						continue;
					}
					const value = battery ? data[0] : data.readFloatLE();
					if (
						Number.isFinite(value) &&
						value >= field.min &&
						value <= field.max
					) {
						readings.push({
							field,
							value: Math.round(value * 100) / 100,
						});
					}
				}
				if (!readings.length) {
					throw new GatewayError(
						"GATT_ERROR",
						"The Flower Power sensor did not return readable measurements",
					);
				}
				return readings;
			},
		);
		if (this.poller.disposed) {
			return;
		}
		await extendDevice(address, peripheral, {
			common: {
				name:
					peripheral.advertisement.localName || "Parrot Flower Power",
			},
		});
		for (const { field, value } of readings) {
			if (this.poller.disposed) {
				return;
			}
			const id = `${address}.${field.id}`;
			await extendState(id, {
				id: field.id,
				common: {
					name: field.name,
					role: field.role,
					unit: field.unit,
					type: "number",
					read: true,
					write: false,
				},
			});
			await this.adapter.setStateChangedAsync(id, value, true);
		}
	}
}
