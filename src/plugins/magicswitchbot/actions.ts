import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import type {
	ConnectionManager,
	SessionOptions,
} from "../../connections/connection-manager";
import { GatewayError } from "../../lib/gateway-error";

const SERVICE = "fee7";
const WRITE = "36f5";
const NOTIFY = "36f6";
const DEVICE_PROTOCOL_KEY = Buffer.from(
	"2a61395c405549513a5a4b621b6d3735",
	"hex",
);
const ACTIONS = { off: 0, on: 1, push: 2 } as const;

export type MagicSwitchBotAction = keyof typeof ACTIONS;

function crypt(block: Buffer, decrypt = false): Buffer {
	const cipher = decrypt
		? createDecipheriv("aes-128-ecb", DEVICE_PROTOCOL_KEY, null)
		: createCipheriv("aes-128-ecb", DEVICE_PROTOCOL_KEY, null);
	cipher.setAutoPadding(false);
	return Buffer.concat([cipher.update(block), cipher.final()]);
}

/**
 * Sends one MagicSwitchBot action using the token issued for this connection.
 *
 * @param connections
 * @param address
 * @param action
 * @param pin The device owner's existing six-digit PIN, if enabled
 */
export async function runMagicSwitchBotAction(
	connections: ConnectionManager,
	address: string,
	action: MagicSwitchBotAction,
	pin?: string,
	options: SessionOptions = {},
): Promise<void> {
	await connections.withSession(
		address,
		async (session) => {
			let onReply: ((data: Buffer) => void) | undefined;
			await session.subscribe(SERVICE, NOTIFY, (data) => {
				if (data.length === 16) {
					onReply?.(crypt(data, true));
				}
			});
			const request = async (
				command: number,
				parameters: Buffer,
				token?: Buffer,
			): Promise<Buffer> => {
				const block = randomBytes(16);
				block.set([command, 1, parameters.length]);
				parameters.copy(block, 3);
				token?.copy(block, 3 + parameters.length);
				const reply = Promise.withResolvers<Buffer>();
				onReply = (data) => {
					if (data[0] === command) {
						reply.resolve(data);
					}
				};
				const timer = setTimeout(
					() =>
						reply.reject(
							new GatewayError(
								"TIMEOUT",
								"MagicSwitchBot did not answer",
							),
						),
					4000,
				);
				try {
					const [, answer] = await Promise.all([
						session.write(SERVICE, WRITE, crypt(block), true),
						reply.promise,
					]);
					return answer;
				} finally {
					onReply = undefined;
					clearTimeout(timer);
				}
			};

			const auth = await request(0x06, Buffer.from(pin ?? "", "ascii"));
			if (
				auth[1] !== 0x02 ||
				(auth[2] !== 4 && (auth[2] !== 9 || auth[10] !== 0x07))
			) {
				throw new GatewayError(
					"GATT_ERROR",
					"MagicSwitchBot did not accept the PIN or identify the device",
				);
			}
			const result = await request(
				0x05,
				Buffer.from([ACTIONS[action]]),
				auth.subarray(3, 7),
			);
			if (result[1] !== 0x02 || result[2] !== 1 || result[3] !== 0) {
				throw new GatewayError(
					"GATT_ERROR",
					"MagicSwitchBot rejected the action",
				);
			}
			// Let the arm finish moving before another queued command can begin.
			await wait(2250);
		},
		options,
	);
}
