/** How often an unchanged value is written anyway, so the state's ts tells when it was last received */
export const VALUE_REFRESH_MS = 10 * 60000;

type Value = ioBroker.StateValue;

/** What the ValueWriter needs from the adapter */
export interface ValueWriterTarget {
	setStateAsync(id: string, value: Value, ack: true): Promise<unknown>;
	setStateChangedAsync(id: string, value: Value, ack: true): Promise<unknown>;
}

/**
 * Writes decoded values. A changed value is written at once, an unchanged one at most every
 * VALUE_REFRESH_MS. Without the refresh, the ts of a value that never changes (a full battery)
 * would grow old although the device keeps sending it.
 */
export class ValueWriter {
	/** When each state was last written by this writer */
	private readonly written = new Map<string, number>();

	/**
	 * @param target The adapter
	 * @param now The clock, replaceable in tests
	 */
	public constructor(
		private readonly target: ValueWriterTarget,
		private readonly now: () => number = Date.now,
	) {}

	/**
	 * Writes a value with ack
	 *
	 * @param id Full ID of the state
	 * @param value The decoded value
	 */
	public async write(id: string, value: Value): Promise<void> {
		const now = this.now();
		const last = this.written.get(id);
		if (last === undefined || now - last >= VALUE_REFRESH_MS) {
			await this.target.setStateAsync(id, value, true);
			this.written.set(id, now);
			return;
		}
		const result = (await this.target.setStateChangedAsync(
			id,
			value,
			true,
		)) as { notChanged?: boolean } | undefined;
		if (!result?.notChanged) {
			this.written.set(id, now);
		}
	}
}
