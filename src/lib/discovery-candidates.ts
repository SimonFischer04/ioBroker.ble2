import type { PeripheralInfo } from "./scanProcessInterface";

interface CandidateSummary {
	address: string;
	name: string;
}

interface Candidate {
	peripheral: PeripheralInfo;
	name: string;
	expiresAt: number;
}

const defaultLifetime = 15 * 60_000;
const defaultLimit = 256;
const addressPattern =
	/^(?:[0-9a-f]{12}|(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}|[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i;

/** Keeps a temporary, bounded list of devices waiting for approval. */
export class DiscoveryCandidates {
	private readonly candidates = new Map<string, Candidate>();
	private readonly approving = new Set<string>();
	private readonly approved = new Set<string>();
	private expiryTimer: ioBroker.Timeout | undefined;
	private publishQueued = false;
	private pendingPublish = Promise.resolve();
	private disposed = false;

	/**
	 * @param adapter Instance timer and logging methods.
	 * @param writeList Publishes the temporary device list.
	 * @param lifetime Time to retain a device after its last advertisement.
	 * @param limit Maximum number of devices in the list.
	 */
	constructor(
		private readonly adapter: Pick<
			ioBroker.Adapter,
			"setTimeout" | "clearTimeout" | "log"
		>,
		private readonly writeList: (list: CandidateSummary[]) => Promise<void>,
		private readonly lifetime = defaultLifetime,
		private readonly limit = defaultLimit,
	) {}

	/**
	 * Records the latest advertisement for a device on the review list.
	 *
	 * @param peripheral Peripheral that advertised during a discovery window.
	 */
	public observe(peripheral: PeripheralInfo): void {
		const address = peripheral.address;
		if (
			this.disposed ||
			!addressPattern.test(address) ||
			this.approving.has(address) ||
			this.approved.has(address)
		) {
			return;
		}
		this.expire();
		const previous = this.candidates.get(address);
		if (!previous && this.candidates.size >= this.limit) {
			return;
		}
		const advertisedName = peripheral.advertisement.localName;
		const name =
			(typeof advertisedName === "string" &&
				advertisedName.trim().slice(0, 80)) ||
			previous?.name ||
			"";
		this.candidates.delete(address);
		this.candidates.set(address, {
			peripheral,
			name,
			expiresAt: Date.now() + this.lifetime,
		});
		if (previous?.name !== name) {
			this.queuePublish();
		}
		this.scheduleExpiry();
	}

	/** @param address Device address in a scanner advertisement. */
	public isPending(address: string): boolean {
		return (
			this.approving.has(address) ||
			(this.candidates.get(address)?.expiresAt ?? 0) > Date.now()
		);
	}

	/** @param address Address of a device approved during this adapter session. */
	public isApproved(address: string): boolean {
		return this.approved.has(address);
	}

	/** Returns the unexpired devices visible to Admin and in the preview state. */
	public list(): CandidateSummary[] {
		const now = Date.now();
		return [...this.candidates]
			.filter(([, candidate]) => candidate.expiresAt > now)
			.map(([address, { name }]) => ({ address, name }))
			.sort((a, b) => a.address.localeCompare(b.address));
	}

	/**
	 * Approves a device with the last advertisement received for it.
	 *
	 * @param address Address selected in Admin.
	 * @param record Creates the device and updates its states.
	 */
	public async approve(
		address: string,
		record: (peripheral: PeripheralInfo) => Promise<void>,
	): Promise<boolean> {
		if (this.approved.has(address)) {
			return true;
		}
		this.expire();
		const candidate = this.candidates.get(address);
		if (this.disposed || !candidate || this.approving.has(address)) {
			return false;
		}
		this.approving.add(address);
		try {
			await record(candidate.peripheral);
			if (!this.disposed) {
				this.approved.add(address);
				this.candidates.delete(address);
				this.queuePublish();
			}
			return true;
		} finally {
			this.approving.delete(address);
		}
	}

	/** @param address Device address whose RSSI object was deleted. */
	public forgetApproval(address: string): void {
		this.approved.delete(address);
	}

	/** Cancels expiration and clears the published preview on unload. */
	public async dispose(): Promise<void> {
		this.disposed = true;
		if (this.expiryTimer != undefined) {
			this.adapter.clearTimeout(this.expiryTimer);
			this.expiryTimer = undefined;
		}
		this.candidates.clear();
		this.approved.clear();
		await this.pendingPublish;
		await this.publishList([]);
	}

	private expire(): void {
		let removed = false;
		const now = Date.now();
		for (const [address, candidate] of this.candidates) {
			if (candidate.expiresAt > now) {
				break;
			}
			this.candidates.delete(address);
			removed = true;
		}
		if (removed) {
			this.queuePublish();
		}
	}

	private scheduleExpiry(): void {
		const first = this.candidates.values().next().value;
		if (this.expiryTimer == undefined && first) {
			this.expiryTimer = this.adapter.setTimeout(
				() => {
					this.expiryTimer = undefined;
					this.expire();
					this.scheduleExpiry();
				},
				Math.max(1, first.expiresAt - Date.now()),
			);
		}
	}

	private queuePublish(): void {
		if (this.publishQueued || this.disposed) {
			return;
		}
		this.publishQueued = true;
		this.pendingPublish = this.pendingPublish.then(async () => {
			this.publishQueued = false;
			if (!this.disposed) {
				await this.publishList(this.list());
			}
		});
	}

	private async publishList(list: CandidateSummary[]): Promise<void> {
		try {
			await this.writeList(list);
		} catch (error) {
			this.adapter.log.warn(
				`Could not publish the discovery list: ${String(error)}`,
			);
		}
	}
}
