// @ts-check

/**
 * Plays the instance that owns gateways able to connect, e.g. ioBroker.esphome with its Bluetooth
 * proxies: it answers the gatt:* commands the adapter sends to test.0 and simulates one device
 * behind every gateway.
 */

const { NAMESPACE, getMessageClient } = require("./helpers");

// Service 0x1f10 with one characteristic 0x1f1f (read, write without response, notify), like the
// pvvx thermometers
const SERVICES = [
	{
		uuid: "00001f10-0000-1000-8000-00805f9b34fb",
		handle: 30,
		characteristics: [
			{
				uuid: "00001f1f-0000-1000-8000-00805f9b34fb",
				handle: 32,
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
	// The Telink firmware update (read, write without response)
	{
		uuid: "00010203-0405-0607-0809-0a0b0c0d1912",
		handle: 40,
		characteristics: [
			{
				uuid: "00010203-0405-0607-0809-0a0b0c0d2b12",
				handle: 42,
				properties: 0x06,
				descriptors: [],
			},
		],
	},
];

/**
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise<void>}
 */
function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

class FakeGattGateway {
	/**
	 * @param {any} harness - Integration test harness
	 */
	constructor(harness) {
		this.client = getMessageClient(harness);
		/** Open connections as "<gatewayId>|<address>" */
		this.open = new Set();
		/** @type {Map<string, number>} Most connections to one address at the same time */
		this.maxOpen = new Map();
		/** @type {Map<number, string>} Value of every handle, as hex */
		this.values = new Map();
		/** @type {{command: string, message: any}[]} Every gatt:* command, in order */
		this.commands = [];
		/** @type {Record<string, string>} Error code gatt:connect answers with, per gateway */
		this.failConnect = {};
		/** @type {Record<string, number>} How long gatt:connect takes, per gateway */
		this.connectDelayMs = {};
		/** @type {Set<string>} Commands that are not answered */
		this.silent = new Set();
		/** @type {Set<string>} Subscribed handles as "<gatewayId>|<address>|<handle>" */
		this.subscriptions = new Set();
		/**
		 * Answers writes with notifications, see setWriteHandler()
		 *
		 * @type {((address: string, handle: number, dataHex: string) => string[] | undefined) | undefined}
		 */
		this.writeHandler = undefined;
		/**
		 * Answers reads, see setReadHandler()
		 *
		 * @type {((address: string, handle: number) => string | undefined) | undefined}
		 */
		this.readHandler = undefined;
		this.client.onRequest((command, message) =>
			this.handle(command, message),
		);
	}

	/**
	 * Sets what the device answers to writes: the payloads (hex) are sent as notifications to ble.0
	 * after the write was answered, if the handle was subscribed on this connection
	 *
	 * @param {((address: string, handle: number, dataHex: string) => string[] | undefined) | undefined} handler - The handler
	 */
	setWriteHandler(handler) {
		this.writeHandler = handler;
	}

	/**
	 * Sets what the device answers to reads: hex, or undefined for the value in `values`
	 *
	 * @param {((address: string, handle: number) => string | undefined) | undefined} handler - The handler
	 */
	setReadHandler(handler) {
		this.readHandler = handler;
	}

	/**
	 * The connections to a device end, like when it restarts or is out of range. ble.0 is told.
	 *
	 * @param {string} address - The device
	 */
	dropConnection(address) {
		for (const key of [...this.open]) {
			const [gatewayId, keyAddress] = key.split("|");
			if (keyAddress !== address) continue;
			this.open.delete(key);
			for (const subscription of [...this.subscriptions]) {
				if (subscription.startsWith(`${key}|`)) {
					this.subscriptions.delete(subscription);
				}
			}
			this.client.push(`system.adapter.${NAMESPACE}`, {
				command: "gateway:connectionState",
				message: { gatewayId, address, connected: false },
				from: this.client.from,
			});
		}
	}

	/**
	 * @param {any} message - gatt:read or gatt:writeSequence
	 * @returns {string} The value of the handle, base64
	 */
	readValue(message) {
		const hex =
			this.readHandler?.(message.address, message.handle) ??
			this.values.get(message.handle) ??
			"";
		return Buffer.from(hex, "hex").toString("base64");
	}

	/**
	 * Writes a value like the device does and sends the notifications the write handler returns
	 *
	 * @param {string} key - "<gatewayId>|<address>"
	 * @param {any} message - gatt:write or gatt:writeSequence
	 * @param {string} data - The value, base64
	 */
	applyWrite(key, message, data) {
		const dataHex = Buffer.from(data, "base64").toString("hex");
		this.values.set(message.handle, dataHex);
		const notifications = this.writeHandler?.(
			message.address,
			message.handle,
			dataHex,
		);
		if (
			notifications &&
			this.subscriptions.has(`${key}|${message.handle}`)
		) {
			// After the answer to the write
			setTimeout(() => {
				for (const hex of notifications) {
					this.client.push(`system.adapter.${NAMESPACE}`, {
						command: "gateway:notification",
						message: {
							gatewayId: message.gatewayId,
							address: message.address,
							handle: message.handle,
							data: Buffer.from(hex, "hex").toString("base64"),
						},
						from: this.client.from,
					});
				}
			}, 10);
		}
	}

	/** Forgets what happened so far, keeps the open connections */
	reset() {
		this.commands.length = 0;
		this.maxOpen.clear();
		this.failConnect = {};
		this.connectDelayMs = {};
		this.silent.clear();
	}

	/**
	 * The commands received so far, as "<command> <gatewayId>"
	 *
	 * @returns {string[]}
	 */
	get log() {
		return this.commands.map((c) => `${c.command} ${c.message.gatewayId}`);
	}

	/**
	 * @param {string} code - Error code
	 * @param {string} message - Error message
	 */
	static error(code, message) {
		return { error: { code, message } };
	}

	/**
	 * @param {string} command - The command ble sent
	 * @param {any} message - Its payload
	 * @returns {Promise<any>} The answer, undefined to leave it unanswered
	 */
	async handle(command, message) {
		if (!command.startsWith("gatt:")) return undefined;
		this.commands.push({ command, message });
		if (this.silent.has(command)) return undefined;

		const key = `${message.gatewayId}|${message.address}`;
		switch (command) {
			case "gatt:connect": {
				const wait = this.connectDelayMs[message.gatewayId];
				if (wait) await delay(wait);
				const code = this.failConnect[message.gatewayId];
				if (code)
					return FakeGattGateway.error(
						code,
						`connecting failed (${code})`,
					);
				this.open.add(key);
				const count = [...this.open].filter((k) =>
					k.endsWith(`|${message.address}`),
				).length;
				this.maxOpen.set(
					message.address,
					Math.max(this.maxOpen.get(message.address) ?? 0, count),
				);
				return { error: null, result: { mtu: 23 } };
			}
			case "gatt:disconnect":
				this.open.delete(key);
				for (const subscription of [...this.subscriptions]) {
					if (subscription.startsWith(`${key}|`)) {
						this.subscriptions.delete(subscription);
					}
				}
				return { error: null, result: {} };
		}

		if (!this.open.has(key)) {
			return FakeGattGateway.error(
				"NOT_CONNECTED",
				`no connection to ${message.address}`,
			);
		}
		switch (command) {
			case "gatt:getServices":
				return { error: null, result: { services: SERVICES } };
			case "gatt:read":
				return {
					error: null,
					result: { data: this.readValue(message) },
				};
			case "gatt:write":
				this.applyWrite(key, message, message.data);
				return { error: null, result: {} };
			case "gatt:writeSequence": {
				const count = message.data.length;
				for (const [written, data] of message.data.entries()) {
					if (!this.open.has(key)) {
						return FakeGattGateway.error(
							"NOT_CONNECTED",
							`The connection ended after ${written} of ${count} writes`,
						);
					}
					this.applyWrite(key, message, data);
				}
				if (!this.open.has(key)) {
					return FakeGattGateway.error(
						"NOT_CONNECTED",
						`The connection ended after ${count} of ${count} writes`,
					);
				}
				return {
					error: null,
					result: message.readAfter
						? { written: count, data: this.readValue(message) }
						: { written: count },
				};
			}
			case "gatt:subscribe":
				this.subscriptions.add(`${key}|${message.handle}`);
				return { error: null, result: {} };
			default:
				return FakeGattGateway.error(
					"INVALID_PAYLOAD",
					`unknown command ${command}`,
				);
		}
	}
}

module.exports = { FakeGattGateway, SERVICES };
