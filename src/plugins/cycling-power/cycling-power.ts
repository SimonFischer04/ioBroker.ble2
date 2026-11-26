import type { ConnectionManager } from "../../connections/connection-manager";
import type { GattSession } from "../../connections/gatt-session";
import type { PeripheralInfo } from "../../lib/advertisement";
import { normalizeAddress } from "../../lib/advertisement";
import { extendDevice, extendState } from "../../lib/iobroker-objects";

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
			"withSession" | "bestGateway"
		>,
		addresses: readonly string[],
	) {
		for (const address of addresses) {
			this.sensors.set(address, { running: false, retryAt: 0 });
		}
	}

	public observe(peripheral: PeripheralInfo): void {
		const address = normalizeAddress(peripheral.address);
		const sensor = address ? this.sensors.get(address) : undefined;
		if (
			!address ||
			!sensor ||
			this.stopped ||
			sensor.running ||
			Date.now() < sensor.retryAt ||
			!this.connections.bestGateway(address)
		) {
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
						`Cycling Power session for ${address} ended: ${error instanceof Error ? error.message : "Unknown error"}`,
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
								`Could not store cycling power for ${address}: ${error instanceof Error ? error.message : "Unknown error"}`,
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
