import type { PeripheralInfo } from "../lib/advertisement";
import { errorMessage } from "../lib/gateway-error";
import type { ConnectionManager } from "./connection-manager";

/** How long to wait before asking again whether a gateway that can connect receives a device */
export const GATEWAY_CHECK_MS = 10_000;

/** Timing and wording of a DevicePoller */
export interface DevicePollerOptions {
	/** Time between two successful polls of a device */
	intervalMs: number;
	/** Time until the next attempt after a failed poll */
	retryMs: number;
	/** Completes the warning "Could not <what> <address>: ...", e.g. "read the battery of" */
	what: string;
}

/**
 * Polls configured devices over a gateway when they are in range: a device is due when it is first
 * seen, then after each interval, or after the retry time when a poll failed. Plugins supply only
 * the poll itself.
 */
export class DevicePoller {
	private readonly nextPoll: Map<string, number>;
	private stopped = false;

	/**
	 * @param log Where failed polls are reported
	 * @param connections Tells whether a gateway that can connect receives a device
	 * @param addresses The configured devices, lowercase with colons
	 * @param options Timing and wording
	 * @param poll Polls one device, rejects when it fails
	 */
	public constructor(
		private readonly log: Pick<ioBroker.Logger, "warn">,
		private readonly connections: Pick<ConnectionManager, "candidates">,
		addresses: readonly string[],
		private readonly options: DevicePollerOptions,
		private readonly poll: (
			address: string,
			peripheral: PeripheralInfo,
		) => Promise<void>,
	) {
		this.nextPoll = new Map(addresses.map((address) => [address, 0]));
	}

	/**
	 * To be called for every received advertisement. Starts the poll of a due device.
	 *
	 * @param peripheral The advertisement
	 */
	public observe(peripheral: PeripheralInfo): void {
		const address = peripheral.address;
		const due = this.nextPoll.get(address);
		const now = Date.now();
		if (due === undefined || this.stopped || now < due) {
			return;
		}
		if (this.connections.candidates(address).length === 0) {
			// Received only by gateways that cannot connect: do not ask on every advertisement
			this.nextPoll.set(address, now + GATEWAY_CHECK_MS);
			return;
		}
		this.nextPoll.set(address, Infinity);
		this.poll(address, peripheral).then(
			() => this.schedule(address, this.options.intervalMs),
			(error: unknown) => {
				if (!this.stopped) {
					this.log.warn(
						`Could not ${this.options.what} ${address}: ${errorMessage(error)}`,
					);
				}
				this.schedule(address, this.options.retryMs);
			},
		);
	}

	/** Whether dispose() was called: a running poll should not write any more */
	public get disposed(): boolean {
		return this.stopped;
	}

	/** Stops polling, a running poll is not reported any more */
	public dispose(): void {
		this.stopped = true;
		this.nextPoll.clear();
	}

	/**
	 * @param address The device
	 * @param delayMs When it is due again
	 */
	private schedule(address: string, delayMs: number): void {
		if (!this.stopped) {
			this.nextPoll.set(address, Date.now() + delayMs);
		}
	}
}
