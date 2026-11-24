// A simulated pvvx thermometer for the unit tests. Not used by the adapter itself.

import type { GattLink } from "../../connections/gatt-link";
import { GattSession } from "../../connections/gatt-session";
import type { GatewayError } from "../../lib/gateway-error";
import type { GattServiceInfo } from "../../lib/gateway-protocol";
import {
	CMD_CONFIG,
	CMD_TIME,
	PVVX_COMMAND_CHARACTERISTIC,
	PVVX_SERVICE,
} from "./protocol";

export const COMMAND_HANDLE = 32;

/** Answer of a pvvx firmware 5.9 with hardware ID 0, docs/pvvx-protocol.md 7.3 */
export const DEFAULT_CONFIG_RESPONSE = "5559000000000a048b003700";

/** A pvvx thermometer behind a link: answers the commands 0x55 and 0x23 with notifications */
export class FakePvvxDevice implements GattLink {
	public constructor(
		public readonly address: string = "a4:c1:38:12:34:56",
		public readonly gatewayId: string = "esphome.0:proxy-og",
		public readonly mtu: number = 23,
	) {}

	/** Value of the device clock, local time as Unix seconds */
	public clock = 0;
	/** When the clock was set last, only reported with timeAdjust */
	public lastSet = 0;
	/** Whether the answers to 0x23 carry lastSet (9 bytes) */
	public timeAdjust = false;
	/** Whether setting the clock is ignored, the answer then has the old value */
	public ignoreSetTime = false;
	public configResponse: Buffer = Buffer.from(DEFAULT_CONFIG_RESPONSE, "hex");
	/** Commands the device does not answer */
	public silentCommands: number[] = [];
	/** Notifications sent before every answer, e.g. measurements (0x33) */
	public beforeEachAnswer: Buffer[] = [];
	/** Every write fails with this error */
	public failWrite: GatewayError | undefined;

	public readonly writes: { data: Buffer; withResponse: boolean }[] = [];
	public disconnects = 0;
	private listener: ((data: Buffer) => void) | undefined;

	public getServices(): Promise<GattServiceInfo[]> {
		return Promise.resolve([
			{
				uuid: PVVX_SERVICE,
				handle: 30,
				characteristics: [
					{
						uuid: PVVX_COMMAND_CHARACTERISTIC,
						handle: COMMAND_HANDLE,
						// Read, write without response, notify
						properties: 0x16,
						descriptors: [
							{
								uuid: "00002902-0000-1000-8000-00805f9b34fb",
								handle: 33,
							},
						],
					},
				],
			},
		]);
	}

	public read(): Promise<Buffer> {
		return Promise.resolve(this.configResponse);
	}

	public write(
		handle: number,
		data: Buffer,
		withResponse: boolean,
	): Promise<void> {
		if (this.failWrite) return Promise.reject(this.failWrite);
		this.writes.push({ data: Buffer.from(data), withResponse });
		const listener = this.listener;
		const command = data[0];
		if (
			handle === COMMAND_HANDLE &&
			listener &&
			!this.silentCommands.includes(command)
		) {
			const answer = this.answer(data);
			setImmediate(() => {
				for (const notification of this.beforeEachAnswer) {
					listener(notification);
				}
				listener(answer);
			});
		}
		return Promise.resolve();
	}

	private answer(data: Buffer): Buffer {
		const command = data[0];
		if (command === CMD_CONFIG) return this.configResponse;
		if (command === CMD_TIME && data.length >= 5) {
			if (!this.ignoreSetTime) {
				this.clock = data.readUInt32LE(1);
				this.lastSet = this.clock;
			}
			return this.timeResponse();
		}
		if (command === CMD_TIME) return this.timeResponse();
		return Buffer.from([command, 0xff]);
	}

	private timeResponse(): Buffer {
		const answer = Buffer.alloc(this.timeAdjust ? 9 : 5);
		answer[0] = CMD_TIME;
		answer.writeUInt32LE(this.clock >>> 0, 1);
		if (this.timeAdjust) answer.writeUInt32LE(this.lastSet >>> 0, 5);
		return answer;
	}

	public subscribe(
		handle: number,
		listener: (data: Buffer) => void,
	): Promise<void> {
		if (handle === COMMAND_HANDLE) this.listener = listener;
		return Promise.resolve();
	}

	public disconnect(): Promise<void> {
		this.disconnects++;
		return Promise.resolve();
	}

	public onDisconnect(): void {
		// The simulated device never ends the connection by itself
	}
}

/** A real GattSession over the simulated device */
export function createFakeSession(device: FakePvvxDevice): GattSession {
	return new GattSession(device);
}
