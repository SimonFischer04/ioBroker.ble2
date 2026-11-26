interface RssiEntry {
	timestamp?: number | null;
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
	 */
	public async update(id: string, value: number): Promise<void> {
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
				}
			}
			const now = Date.now();
			if (
				this.entries.get(id) === current &&
				(current.timestamp === null ||
					current.timestamp + this.intervalMs < now)
			) {
				this.adapter.log.debug(`updating RSSI state ${id}`);
				await this.adapter.setStateAsync(id, value, true);
				current.timestamp = Math.max(current.timestamp ?? 0, now);
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
			entry.timestamp = Math.max(entry.timestamp ?? 0, state.ts);
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
