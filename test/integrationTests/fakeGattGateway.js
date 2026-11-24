// @ts-check

/**
 * Plays the instance that owns gateways able to connect, e.g. ioBroker.esphome with its Bluetooth
 * proxies: it answers the gatt:* commands the adapter sends to test.0 and simulates one device
 * behind every gateway.
 */

const { getMessageClient } = require("./helpers");

// Service 0x1f10 with one characteristic 0x1f1f (read, write, notify), like the pvvx thermometers
const SERVICES = [
	{
		uuid: "00001f10-0000-1000-8000-00805f9b34fb",
		handle: 30,
		characteristics: [
			{
				uuid: "00001f1f-0000-1000-8000-00805f9b34fb",
				handle: 32,
				properties: 0x1a,
				descriptors: [
					{
						uuid: "00002902-0000-1000-8000-00805f9b34fb",
						handle: 33,
					},
				],
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
		this.client.onRequest((command, message) =>
			this.handle(command, message),
		);
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
					result: {
						data: Buffer.from(
							this.values.get(message.handle) ?? "",
							"hex",
						).toString("base64"),
					},
				};
			case "gatt:write":
				this.values.set(
					message.handle,
					Buffer.from(message.data, "base64").toString("hex"),
				);
				return { error: null, result: {} };
			case "gatt:subscribe":
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
