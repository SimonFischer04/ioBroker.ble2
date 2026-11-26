interface RssiEntry {
	timestamp?: number | null;
	wasReset?: boolean;
	pending: Promise<void>;
}

/** Uses state-change notifications to keep RSSI throttling timestamps in memory. */
export class RssiUpdates {
	private readonly entries = new Map<string, RssiEntry>();

	/**
	 * @param adapter Adapter state and logging methods.
	 * @param intervalMs Minimum time between RSSI updates.
	 */
	constructor(
		private readonly adapter: Pick<
			ioBroker.Adapter,
			"getStateAsync" | "setStateAsync" | "log"
		>,
		private readonly intervalMs: number,
	) {}

	/**
	 * Writes RSSI when its update interval has elapsed.
	 *
	 * @param id Fully qualified state ID.
	 * @param value Received signal strength.
	 * @param restoreAfterReset Whether zero marks an expired RSSI.
	 */
	public async update(
		id: string,
		value: number,
		restoreAfterReset = false,
	): Promise<void> {
		let entry = this.entries.get(id);
		if (!entry) {
			entry = { pending: Promise.resolve() };
			this.entries.set(id, entry);
		}
		const current = entry;
		const result = current.pending.then(async () => {
			if (this.entries.get(id) !== current) {
				return;
			}
			if (current.timestamp === undefined) {
				const state = await this.adapter.getStateAsync(id);
				if (current.timestamp === undefined) {
					current.timestamp = state?.ts ?? null;
					current.wasReset = state?.val === 0;
				}
			}
			const now = Date.now();
			if (
				this.entries.get(id) === current &&
				(current.timestamp === null ||
					(restoreAfterReset && current.wasReset) ||
					current.timestamp + this.intervalMs < now)
			) {
				this.adapter.log.debug(`updating RSSI state ${id}`);
				await this.adapter.setStateAsync(id, value, true);
				if ((current.timestamp ?? 0) <= now) {
					current.timestamp = now;
					current.wasReset = value === 0;
				}
			}
		});
		current.pending = result.catch(() => undefined);
		await result;
	}

	/**
	 * Applies an RSSI state change from the adapter subscription.
	 *
	 * @param id Fully qualified state ID.
	 * @param state New state, or null when it was removed.
	 */
	public observe(id: string, state: ioBroker.State | null | undefined): void {
		const entry = this.entries.get(id);
		if (entry && state) {
			if (state.ts >= (entry.timestamp ?? 0)) {
				entry.timestamp = state.ts;
				entry.wasReset = state.val === 0;
			}
		} else if (!state) {
			this.remove(id);
		}
	}

	/**
	 * Forgets cached data for a deleted RSSI object.
	 *
	 * @param id Fully qualified state ID.
	 */
	public remove(id: string): void {
		this.entries.delete(id);
	}
}
