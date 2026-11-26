import { performance } from "node:perf_hooks";

/** Counts quiet time only while the local scanner is actively scanning. */
export class ScannerIdleMonitor {
	private remaining: number;
	private startedAt: number | undefined;
	private timer: ioBroker.Timeout | undefined;

	/**
	 * @param adapter Adapter-managed timers.
	 * @param timeoutMs Active scan time without packets before recovery.
	 * @param onIdle Called once when the active-time budget is exhausted.
	 * @param now Monotonic clock, overridable for tests.
	 */
	constructor(
		private readonly adapter: Pick<
			ioBroker.Adapter,
			"setTimeout" | "clearTimeout"
		>,
		private readonly timeoutMs: number,
		private readonly onIdle: () => void,
		private readonly now: () => number = () => performance.now(),
	) {
		this.remaining = timeoutMs;
	}

	public startWindow(): void {
		if (this.startedAt != null || this.remaining <= 0) {
			return;
		}
		this.startedAt = this.now();
		this.schedule();
	}

	public endWindow(): void {
		if (this.startedAt == null) {
			return;
		}
		this.remaining -= this.now() - this.startedAt;
		this.stop();
		if (this.remaining <= 0) {
			this.onIdle();
		}
	}

	public packet(): void {
		if (this.startedAt != null) {
			this.startedAt = this.now();
			this.remaining = this.timeoutMs;
		}
	}

	public stop(): void {
		this.adapter.clearTimeout(this.timer);
		this.timer = undefined;
		this.startedAt = undefined;
	}

	private schedule(): void {
		this.timer = this.adapter.setTimeout(
			() => {
				if (this.startedAt == null) {
					return;
				}
				const now = this.now();
				this.remaining -= now - this.startedAt;
				this.startedAt = now;
				if (this.remaining > 0) {
					this.schedule();
				} else {
					this.stop();
					this.onIdle();
				}
			},
			Math.max(1, Math.ceil(this.remaining)),
		);
	}
}
