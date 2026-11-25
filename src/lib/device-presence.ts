interface PresenceSettings {
	address: string;
	packets: number;
	absenceSeconds: number;
}

interface TrackedDevice {
	readonly packets: number;
	readonly decayInterval: number;
	deviceId?: string;
	lastPacket: number;
	score: number;
	present: boolean;
	published?: boolean;
	requested?: boolean;
	revision: number;
	timer?: ioBroker.Timeout;
	pending: Promise<void>;
}

function normalizeAddress(address: string): string {
	return address.replace(/[:-]/g, "").trim().toLowerCase();
}

/** Tracks per-device presence from a bounded score that decays between packets. */
export class DevicePresence {
	private readonly devices = new Map<string, TrackedDevice>();
	private stopped = false;

	/**
	 * @param adapter Adapter timer and logging methods.
	 * @param settings Configured Bluetooth devices and their thresholds.
	 * @param write Creates or updates the presence state for a recorded device.
	 */
	constructor(
		private readonly adapter: Pick<
			ioBroker.Adapter,
			"setTimeout" | "clearTimeout" | "log"
		>,
		settings: readonly PresenceSettings[],
		private readonly write: (
			deviceId: string,
			present: boolean,
		) => Promise<void>,
	) {
		for (const row of settings) {
			if (!row) {
				continue;
			}
			const { address, packets, absenceSeconds } = row;
			const mac =
				typeof address === "string" ? normalizeAddress(address) : "";
			if (
				!/^[0-9a-f]{12}$/.test(mac) ||
				!Number.isInteger(packets) ||
				packets < 1 ||
				packets > 20 ||
				!Number.isInteger(absenceSeconds) ||
				absenceSeconds < 1 ||
				absenceSeconds > 86400
			) {
				continue;
			}
			this.devices.set(mac, {
				packets,
				decayInterval: Math.ceil((absenceSeconds * 1000) / packets),
				lastPacket: 0,
				score: 0,
				present: false,
				revision: 0,
				pending: Promise.resolve(),
			});
		}
	}

	/** @param deviceId Address of a device recorded in this instance. */
	public restore(deviceId: string): void {
		const device = this.devices.get(normalizeAddress(deviceId));
		if (!this.stopped && device && device.deviceId == undefined) {
			device.deviceId = deviceId;
			this.publish(device);
		}
	}

	/** @param deviceId Address of the device that sent the advertisement. */
	public observe(deviceId: string): void {
		const device = this.devices.get(normalizeAddress(deviceId));
		if (this.stopped || !device) {
			return;
		}
		device.deviceId = deviceId;
		const now = Date.now();
		const elapsed = Math.max(0, now - device.lastPacket);
		const remaining = Math.max(
			0,
			device.score - Math.floor(elapsed / device.decayInterval),
		);
		device.score = Math.min(device.packets, remaining + 1);
		device.lastPacket = now;
		device.present =
			device.score >= device.packets || (device.present && remaining > 0);
		if (device.present) {
			device.timer ??= this.adapter.setTimeout(
				() => this.check(device),
				device.score * device.decayInterval,
			);
		} else if (device.timer != null) {
			this.adapter.clearTimeout(device.timer);
			device.timer = undefined;
		}
		this.publish(device);
	}

	/** @param deviceId Recorded address whose device or presence state was removed. */
	public remove(deviceId: string): void {
		const device = this.devices.get(normalizeAddress(deviceId));
		if (device?.deviceId === deviceId) {
			this.reset(device);
		}
	}

	/** Cancels presence checks on adapter unload. */
	public stop(): void {
		this.stopped = true;
		for (const device of this.devices.values()) {
			this.reset(device);
		}
	}

	private reset(device: TrackedDevice): void {
		if (device.timer != null) {
			this.adapter.clearTimeout(device.timer);
		}
		device.timer = undefined;
		device.deviceId = undefined;
		device.score = 0;
		device.present = false;
		device.published = undefined;
		device.requested = undefined;
		device.revision++;
	}

	private check(device: TrackedDevice): void {
		device.timer = undefined;
		const remaining =
			device.lastPacket +
			device.score * device.decayInterval -
			Date.now();
		if (remaining > 0 && device.present) {
			device.timer = this.adapter.setTimeout(
				() => this.check(device),
				remaining,
			);
		} else {
			device.score = 0;
			device.present = false;
			this.publish(device);
		}
	}

	private publish(device: TrackedDevice): void {
		const { deviceId, present, revision } = device;
		if (deviceId == undefined || device.requested === present) {
			return;
		}
		device.requested = present;
		device.pending = device.pending
			.then(async () => {
				if (
					device.revision === revision &&
					device.published !== present
				) {
					await this.write(deviceId, present);
					if (device.revision === revision) {
						device.published = present;
					}
				}
			})
			.catch((error: unknown) => {
				if (
					device.revision === revision &&
					device.requested === present
				) {
					device.requested = undefined;
				}
				this.adapter.log.warn(
					`Could not update presence for ${deviceId}: ${String(error)}`,
				);
			});
	}
}
