import {
	createHmac,
	hkdfSync,
	randomBytes,
	timingSafeEqual,
} from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import type {
	ConnectionManager,
	SessionOptions,
} from "../../connections/connection-manager";
import type { GattCharacteristicInfo } from "../../lib/gateway-protocol";
import { GatewayError } from "../../lib/gateway-error";

const AUTH_SERVICE = "0000fe95-0000-1000-8000-00805f9b34fb";
const AUTH_CONTROL = "00000010-0000-1000-8000-00805f9b34fb";
const AUTH_DATA = "00000019-0000-1000-8000-00805f9b34fb";
const KETTLE_SERVICE = "01344736-0000-1000-8000-262837236156";
const KETTLE_STATUS = "0000aa02-0000-1000-8000-00805f9b34fb";

const READY = "00000101";
const RECEIVED = "00000100";
const AUTH_STEP_TIMEOUT_MS = 3000;
const STATUSES = ["idle", "heating", "heating", "keeping_warm", "cooling"];

// Several notifications can arrive before the BLE write that caused them completes.
class Notifications {
	private readonly queued: Buffer[] = [];
	private receive?: (data: Buffer) => boolean;

	public push(data: Buffer): void {
		if (this.receive?.(data)) {
			return;
		}
		this.queued.push(data);
		if (this.queued.length > 16) {
			this.queued.shift();
		}
	}

	public clear(): void {
		this.queued.length = 0;
	}

	public take(
		matches: (data: Buffer) => boolean,
		timeoutMs = AUTH_STEP_TIMEOUT_MS,
	): Promise<Buffer> {
		const index = this.queued.findIndex(matches);
		if (index >= 0) {
			return Promise.resolve(this.queued.splice(index, 1)[0]);
		}
		const reply = Promise.withResolvers<Buffer>();
		this.receive = (data) => {
			if (!matches(data)) {
				return false;
			}
			reply.resolve(data);
			return true;
		};
		const timer = setTimeout(() => {
			reply.reject(
				new GatewayError(
					"TIMEOUT",
					"No reply from the Xiaomi Kettle Pro",
				),
			);
		}, timeoutMs);
		return reply.promise.finally(() => {
			this.receive = undefined;
			clearTimeout(timer);
		});
	}

	public async expect(hex: string): Promise<void> {
		const expected = Buffer.from(hex, "hex");
		await this.take((data) => data.equals(expected));
	}

	public async fragment(index: number): Promise<Buffer> {
		const data = await this.take(
			(value) => value.length > 2 && value[0] === index && value[1] === 0,
		);
		return data.subarray(2);
	}
}

interface KettleStatus {
	temperature: number;
	status: string;
}

/**
 * Reads Mi Smart Kettle Pro (yunmi.kettle.v12) telemetry with the paired device token.
 *
 * @param connections Active gateway connections
 * @param address Bluetooth MAC address
 * @param token The 16-byte Xiaomi device token encoded in hexadecimal
 * @param options Gateway selected by the caller
 */
export async function readKettleProStatus(
	connections: ConnectionManager,
	address: string,
	token: unknown,
	options: SessionOptions,
): Promise<KettleStatus> {
	if (typeof token !== "string" || !/^[0-9a-f]{32}$/i.test(token)) {
		throw new GatewayError(
			"INVALID_PAYLOAD",
			'"token" must be 32 hexadecimal characters',
		);
	}
	const deviceKey = Buffer.from(token, "hex");
	return connections.withSession(
		address,
		async (session) => {
			const services = await session.getServices();
			const auth = services.find(({ uuid }) => uuid === AUTH_SERVICE);
			const kettle = services.find(({ uuid }) => uuid === KETTLE_SERVICE);
			const control = auth?.characteristics.find(
				({ uuid }) => uuid === AUTH_CONTROL,
			);
			const data = auth?.characteristics.find(
				({ uuid }) => uuid === AUTH_DATA,
			);
			const status = kettle?.characteristics.find(
				({ uuid }) => uuid === KETTLE_STATUS,
			);
			if (
				!control ||
				!(control.properties & 0x0c) ||
				!(control.properties & 0x30) ||
				!data ||
				!(data.properties & 0x0c) ||
				!(data.properties & 0x30) ||
				!status ||
				!(status.properties & 0x30)
			) {
				throw new GatewayError(
					"GATT_ERROR",
					"The Xiaomi Kettle Pro services were not found",
				);
			}

			const controlReplies = new Notifications();
			const authReplies = new Notifications();
			const readings = new Notifications();
			await session.subscribe(AUTH_SERVICE, AUTH_CONTROL, (value) =>
				controlReplies.push(value),
			);
			await session.subscribe(AUTH_SERVICE, AUTH_DATA, (value) =>
				authReplies.push(value),
			);
			await session.subscribe(KETTLE_SERVICE, KETTLE_STATUS, (value) =>
				readings.push(value),
			);

			async function write(
				characteristic: GattCharacteristicInfo,
				value: Buffer,
			): Promise<void> {
				// Original firmware prefers writes without response when available.
				await session.write(
					AUTH_SERVICE,
					characteristic.uuid,
					value,
					!(characteristic.properties & 0x04),
				);
				await wait(50);
			}
			const send = (hex: string): Promise<void> =>
				write(data, Buffer.from(hex, "hex"));

			await write(control, Buffer.from("a4", "hex"));
			await write(control, Buffer.from("24000000", "hex"));
			await send("0000000b0100"); // Ask the device to receive the client nonce.
			await authReplies.expect(READY);
			const clientNonce = randomBytes(16);
			await write(
				data,
				Buffer.concat([Buffer.from([1, 0]), clientNonce]),
			);
			await authReplies.expect(RECEIVED);

			await authReplies.expect("0000000d0100"); // The device sends its nonce in one fragment.
			await send(READY);
			const deviceNonce = await authReplies.fragment(1);
			if (deviceNonce.length !== 16) {
				throw new GatewayError(
					"GATT_ERROR",
					"Invalid Xiaomi Kettle Pro nonce",
				);
			}
			await send(RECEIVED);

			const salt = Buffer.concat([clientNonce, deviceNonce]);
			const key = Buffer.from(
				hkdfSync("sha256", deviceKey, salt, "mible-login-info", 64),
			);
			const deviceProof = createHmac("sha256", key.subarray(0, 16))
				.update(deviceNonce)
				.update(clientNonce)
				.digest();
			await authReplies.expect("0000000c0200"); // The device sends its proof in two fragments.
			await send(READY);
			const proof = Buffer.concat([
				await authReplies.fragment(1),
				await authReplies.fragment(2),
			]);
			if (
				proof.length !== deviceProof.length ||
				!timingSafeEqual(proof, deviceProof)
			) {
				throw new GatewayError(
					"GATT_ERROR",
					"Xiaomi Kettle Pro authentication failed",
				);
			}
			await send(RECEIVED);

			await send("0000000a0200"); // Ask the device to receive the client proof.
			await authReplies.expect(READY);
			const clientProof = createHmac("sha256", key.subarray(16, 32))
				.update(salt)
				.digest();
			readings.clear();
			await write(
				data,
				Buffer.concat([
					Buffer.from([1, 0]),
					clientProof.subarray(0, 18),
				]),
			);
			await write(
				data,
				Buffer.concat([Buffer.from([2, 0]), clientProof.subarray(18)]),
			);
			await authReplies.expect(RECEIVED);
			await controlReplies.expect("21000000");

			const reading = await readings.take(
				(value) => value.length >= 11,
				8000,
			);
			return {
				temperature: reading[5],
				status: STATUSES[reading[0]] ?? "unknown",
			};
		},
		options,
	);
}
