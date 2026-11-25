/** Restarts a scanner that reports no activity for the configured period. */
export class ScannerWatchdog {
	private lastActivity = 0;
	private timer: ioBroker.Timeout | undefined;

	/**
	 * @param adapter Adapter timer methods.
	 * @param timeoutMs Inactivity threshold in milliseconds, or zero to disable.
	 * @param onIdle Called once in an inactive scan session.
	 */
	constructor(
		private readonly adapter: Pick<
			ioBroker.Adapter,
			"setTimeout" | "clearTimeout"
		>,
		private readonly timeoutMs: number,
		private readonly onIdle: () => void,
	) {}

	/** Starts monitoring or records a new advertisement during a scan. */
	public activity(): void {
		if (this.timeoutMs <= 0) {
			return;
		}
		this.lastActivity = Date.now();
		this.timer ??= this.adapter.setTimeout(
			() => this.check(),
			this.timeoutMs,
		);
	}

	/** Cancels the pending restart when the scan stops. */
	public stop(): void {
		if (this.timer != null) {
			this.adapter.clearTimeout(this.timer);
			this.timer = undefined;
		}
	}

	private check(): void {
		const remaining = this.lastActivity + this.timeoutMs - Date.now();
		if (remaining > 0) {
			this.timer = this.adapter.setTimeout(() => this.check(), remaining);
			return;
		}
		this.timer = undefined;
		this.onIdle();
	}
}
