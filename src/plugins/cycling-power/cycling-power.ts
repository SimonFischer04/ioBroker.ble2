import type { ConnectionManager } from "../../connections/connection-manager";
import { GATEWAY_CHECK_MS } from "../../connections/device-poller";
import type { GattSession } from "../../connections/gatt-session";
import type { PeripheralInfo } from "../../lib/advertisement";
import { extendDevice, extendState } from "../../lib/iobroker-objects";
import { errorMessage } from "../../lib/gateway-error";

const cyclingPowerService = "1818";
const powerMeasurement = "2a63";
const idleMs = 10_000;
const retryMs = 15_000;
const maxSessionMs = 15 * 60_000;

interface Sensor {
	running: boolean;
	retryAt: number;
	finish?: () => void;
}

/** Subscribes to Cycling Power Measurement on configured sensors using a connecting gateway. */
export class CyclingPower {
	private readonly sensors = new Map<string, Sensor>();
	private stopped = false;

	public constructor(
		private readonly adapter: ioBroker.Adapter,
		private readonly connections: Pick<
			ConnectionManager,
			"withSession" | "candidates"
		>,
		addresses: readonly string[],
	) {
		for (const address of addresses) {
			this.sensors.set(address, { running: false, retryAt: 0 });
		}
	}

	public observe(peripheral: PeripheralInfo): void {
		const address = peripheral.address;
		const sensor = this.sensors.get(address);
		const now = Date.now();
		if (!sensor || this.stopped || sensor.running || now < sensor.retryAt) {
			return;
		}
		if (this.connections.candidates(address).length === 0) {
			// Received only by gateways that cannot connect: do not ask on every advertisement
			sensor.retryAt = now + GATEWAY_CHECK_MS;
			return;
		}
		sensor.running = true;
		void this.connections
			.withSession(
				address,
				(session) => this.listen(session, address, peripheral, sensor),
				{ timeoutMs: maxSessionMs },
			)
			.catch((error: unknown) => {
				if (!this.stopped) {
					this.adapter.log.debug(
						`Cycling Power session for ${address} ended: ${errorMessage(error)}`,
					);
				}
			})
			.finally(() => {
				sensor.finish?.();
				sensor.running = false;
				sensor.retryAt = Date.now() + retryMs;
			});
	}

	public dispose(): void {
		this.stopped = true;
		for (const sensor of this.sensors.values()) {
			sensor.finish?.();
		}
	}

	private async listen(
		session: GattSession,
		address: string,
		peripheral: PeripheralInfo,
		sensor: Sensor,
	): Promise<void> {
		await extendDevice(address, peripheral, {
			common: {
				name:
					peripheral.advertisement.localName ||
					"Cycling Power sensor",
			},
		});
		const id = `${address}.cyclingPower`;
		await extendState(id, {
			id: "cyclingPower",
			common: {
				name: "Instantaneous cycling power",
				role: "value.power",
				type: "number",
				unit: "W",
				read: true,
				write: false,
			},
		});

		if (this.stopped || session.closed) {
			return;
		}
		let idleTimer: ioBroker.Timeout | undefined;
		let active = true;
		let pending = Promise.resolve();
		const idle = new Promise<void>((resolve) => {
			sensor.finish = (): void => {
				active = false;
				resolve();
			};
		});
		const refreshIdleTimer = (): void => {
			this.adapter.clearTimeout(idleTimer);
			idleTimer = this.adapter.setTimeout(
				() => sensor.finish?.(),
				idleMs,
			);
		};
		refreshIdleTimer();
		try {
			await session.subscribe(
				cyclingPowerService,
				powerMeasurement,
				(data) => {
					// The mandatory flags and the signed instantaneous power each take two bytes.
					if (!active || session.closed || data.length < 4) {
						return;
					}
					const watts = data.readInt16LE(2);
					refreshIdleTimer();
					pending = pending
						.then(async () => {
							if (!this.stopped) {
								await this.adapter.setStateChangedAsync(
									id,
									watts,
									true,
								);
							}
						})
						.catch((error: unknown) => {
							this.adapter.log.warn(
								`Could not store cycling power for ${address}: ${errorMessage(error)}`,
							);
						});
				},
			);
			await idle;
		} finally {
			sensor.finish?.();
			sensor.finish = undefined;
			this.adapter.clearTimeout(idleTimer);
			await pending;
		}
	}
}
