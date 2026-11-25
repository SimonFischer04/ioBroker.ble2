interface DeviceRssi {
	lastSeen: number;
	timer?: ioBroker.Timeout;
	pending: Promise<void>;
}

/** Resets the signal strength of devices that have stopped advertising. */
export class RssiExpiry {
	private readonly devices = new Map<string, DeviceRssi>();
	private stopped = false;

	/**
	 * @param adapter Adapter state and timer methods.
	 * @param timeoutMs Time without an advertisement before resetting the RSSI.
	 */
	constructor(
		private readonly adapter: Pick<
			ioBroker.Adapter,
			"setTimeout" | "clearTimeout" | "setStateAsync" | "log"
		>,
		private readonly timeoutMs: number,
	) {}

	/**
	 * Schedules an expiration for an RSSI persisted before this instance started.
	 *
	 * @param id Fully qualified RSSI state ID.
	 * @param timestamp Persisted RSSI timestamp.
	 */
	public restore(id: string, timestamp: number): void {
		if (!this.stopped) {
			this.track(id, Math.min(timestamp, Date.now()));
		}
	}

	/**
	 * Records activity and serializes RSSI writes with expiration for this device.
	 *
	 * @param id Fully qualified RSSI state ID.
	 * @param write Existing RSSI update for this advertisement.
	 */
	public async update(id: string, write: () => Promise<void>): Promise<void> {
		if (this.stopped) {
			return;
		}
		const device = this.track(id, Date.now());
		const result = device.pending.then(write);
		device.pending = result.catch(() => undefined);
		await result;
	}

	/**
	 * Discards an RSSI state that was deleted.
	 *
	 * @param id Fully qualified RSSI state ID.
	 */
	public remove(id: string): void {
		const timer = this.devices.get(id)?.timer;
		if (timer != null) {
			this.adapter.clearTimeout(timer);
		}
		this.devices.delete(id);
	}

	/** Cancels device timers when the adapter shuts down. */
	public stop(): void {
		this.stopped = true;
		for (const id of this.devices.keys()) {
			this.remove(id);
		}
	}

	private track(id: string, time: number): DeviceRssi {
		let device = this.devices.get(id);
		if (!device) {
			device = { lastSeen: time, pending: Promise.resolve() };
			this.devices.set(id, device);
		}
		device.lastSeen = time;
		device.timer ??= this.adapter.setTimeout(
			() => this.check(id, device),
			Math.max(0, time + this.timeoutMs - Date.now()),
		);
		return device;
	}

	private check(id: string, device: DeviceRssi): void {
		device.timer = undefined;
		const remaining = device.lastSeen + this.timeoutMs - Date.now();
		if (remaining > 0) {
			device.timer = this.adapter.setTimeout(
				() => this.check(id, device),
				remaining,
			);
			return;
		}

		const timestamp = device.lastSeen;
		device.pending = device.pending
			.then(async () => {
				if (
					this.devices.get(id) !== device ||
					device.lastSeen !== timestamp
				) {
					return;
				}
				await this.adapter.setStateAsync(id, 0, true);
				if (
					device.lastSeen === timestamp &&
					this.devices.get(id) === device
				) {
					this.remove(id);
				}
			})
			.catch((error: unknown) => {
				this.adapter.log.warn(
					`Could not reset ${id}: ${String(error)}`,
				);
				if (this.devices.get(id) === device && device.timer == null) {
					device.timer = this.adapter.setTimeout(
						() => this.check(id, device),
						this.timeoutMs,
					);
				}
			});
	}
}
