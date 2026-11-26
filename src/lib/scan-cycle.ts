/** Serializes scanner transitions and schedules optional pauses between scans. */
export class ScanCycle {
	private enabled = false;
	private revision = 0;
	private timer: NodeJS.Timeout | undefined;
	private transition: Promise<void> = Promise.resolve();

	/**
	 * @param intervalMs Time between scan starts. Zero selects continuous scanning.
	 * @param windowMs Time spent scanning in each interval.
	 * @param begin Starts the physical scan.
	 * @param end Stops the physical scan.
	 * @param onError Reports hardware failures during scheduled transitions.
	 */
	constructor(
		private readonly intervalMs: number,
		private readonly windowMs: number,
		private readonly begin: () => Promise<void>,
		private readonly end: () => Promise<void>,
		private readonly onError: (error: unknown) => void,
	) {}

	/** Enables scanning and begins the first window immediately. */
	public start(): Promise<void> {
		if (this.enabled) {
			return this.transition;
		}
		this.enabled = true;
		return this.beginWindow(++this.revision);
	}

	/** Cancels scheduled transitions and stops the scan. */
	public stop(): Promise<void> {
		if (!this.enabled) {
			return this.transition;
		}
		this.enabled = false;
		this.revision++;
		clearTimeout(this.timer);
		this.timer = undefined;
		return this.enqueue(this.end);
	}

	private beginWindow(revision: number): Promise<void> {
		return this.enqueue(async () => {
			if (revision !== this.revision) {
				return;
			}
			await this.begin();
			if (revision === this.revision && this.intervalMs > this.windowMs) {
				const nextStart = Date.now() + this.intervalMs;
				this.schedule(this.windowMs, () =>
					this.pause(revision, nextStart),
				);
			}
		});
	}

	private pause(revision: number, nextStart: number): Promise<void> {
		return this.enqueue(async () => {
			if (revision !== this.revision) {
				return;
			}
			await this.end();
			if (revision === this.revision) {
				this.schedule(Math.max(0, nextStart - Date.now()), () =>
					this.beginWindow(revision),
				);
			}
		});
	}

	private schedule(delay: number, callback: () => Promise<void>): void {
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void callback().catch(this.onError);
		}, delay);
	}

	private enqueue(transition: () => Promise<void>): Promise<void> {
		const result = this.transition.then(transition);
		this.transition = result.catch(() => undefined);
		return result;
	}
}
