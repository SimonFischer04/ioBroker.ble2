// A simulated pvvx thermometer for the unit tests. Not used by the adapter itself.

import type { GattLink } from "../../connections/gatt-link";
import { GattSession } from "../../connections/gatt-session";
import { GatewayError } from "../../lib/gateway-error";
import type { GattServiceInfo } from "../../lib/gateway-protocol";
import {
	crc16Modbus,
	OTA_CHARACTERISTIC,
	OTA_SERVICE,
	validateImage,
} from "./ota-protocol";
import {
	CMD_CONFIG,
	CMD_TIME,
	PVVX_COMMAND_CHARACTERISTIC,
	PVVX_SERVICE,
} from "./protocol";

export const COMMAND_HANDLE = 32;
export const OTA_HANDLE = 42;

/** The update receiver of the simulated device */
export interface FakeOtaState {
	/** Every write to the update characteristic */
	writes: { data: Buffer; withResponse: boolean }[];
	/** 01 ff was received */
	started: boolean;
	/** The data of the packets received so far, in order */
	received: Buffer[];
	/** Status byte read from the update characteristic */
	status: number;
	/** A valid image and end packet were received, the device runs the new version */
	finished: boolean;
	/** Version the device reports after a successful update */
	newVersion: number;
	/** From this data packet on, the status is set to the value */
	failStatusAfterPackets?: { after: number; status: number };
	/** After this many data packets every further write fails with NOT_CONNECTED */
	dropAfterPackets?: number;
	/** Data packets received, also the invalid ones */
	dataPackets: number;
}

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
	public readonly ota: FakeOtaState = {
		writes: [],
		started: false,
		received: [],
		status: 0,
		finished: false,
		newVersion: 0x60,
		dataPackets: 0,
	};
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
			{
				uuid: OTA_SERVICE,
				handle: 40,
				characteristics: [
					{
						uuid: OTA_CHARACTERISTIC,
						handle: OTA_HANDLE,
						// Read, write without response
						properties: 0x06,
						descriptors: [],
					},
				],
			},
		]);
	}

	public read(handle?: number): Promise<Buffer> {
		if (handle === OTA_HANDLE) {
			return Promise.resolve(Buffer.from([this.ota.status]));
		}
		return Promise.resolve(this.configResponse);
	}

	/** Handles a write to the update characteristic like the Telink firmware */
	private writeOta(data: Buffer, withResponse: boolean): Promise<void> {
		const ota = this.ota;
		const dropped =
			ota.dropAfterPackets !== undefined &&
			ota.dataPackets >= ota.dropAfterPackets;
		if (dropped) {
			return Promise.reject(
				new GatewayError("NOT_CONNECTED", "The device is gone"),
			);
		}
		ota.writes.push({ data: Buffer.from(data), withResponse });
		const setStatus = (status: number): void => {
			if (ota.status === 0) ota.status = status;
		};
		if (data.length === 2 && data[0] === 0x01 && data[1] === 0xff) {
			ota.started = true;
		} else if (data.length === 20) {
			ota.dataPackets++;
			const index = data.readUInt16LE(0);
			if (index !== ota.received.length) {
				setStatus(1);
			} else if (
				crc16Modbus(data.subarray(0, 18)) !== data.readUInt16LE(18)
			) {
				setStatus(2);
			} else {
				ota.received.push(Buffer.from(data.subarray(2, 18)));
			}
			const fail = ota.failStatusAfterPackets;
			if (fail && ota.dataPackets >= fail.after) ota.status = fail.status;
		} else if (data.length === 6 && data[0] === 0x02 && data[1] === 0xff) {
			if (data.readUInt16LE(2) !== ota.received.length - 1) {
				setStatus(4);
			} else if (
				"problem" in validateImage(Buffer.concat(ota.received))
			) {
				setStatus(6);
			} else if (ota.status === 0) {
				ota.finished = true;
				this.configResponse = Buffer.from(this.configResponse);
				this.configResponse[1] = ota.newVersion;
			}
		}
		return Promise.resolve();
	}

	public write(
		handle: number,
		data: Buffer,
		withResponse: boolean,
	): Promise<void> {
		if (this.failWrite) return Promise.reject(this.failWrite);
		if (handle === OTA_HANDLE) return this.writeOta(data, withResponse);
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

	public async writeSequence(
		handle: number,
		data: Buffer[],
		withResponse: boolean,
		readAfter: boolean,
	): Promise<Buffer | undefined> {
		for (const entry of data) await this.write(handle, entry, withResponse);
		return readAfter ? this.read(handle) : undefined;
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
