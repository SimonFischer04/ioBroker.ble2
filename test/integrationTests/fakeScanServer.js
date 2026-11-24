// @ts-check

/**
 * A remote scan server for the integration tests
 *
 * bin/blerp.js (src/scanProcess.ts started without IPC) runs noble on another host and serves what it
 * finds via TCP: one JSON message per line, Buffers as {"type":"Buffer","data":[...]}. This fake speaks
 * the same protocol without Bluetooth, the test decides what it "receives".
 */

const net = require("net");

class FakeScanServer {
	constructor() {
		/** @type {net.Server | null} */
		this.server = null;
		/** @type {Set<net.Socket>} */
		this.sockets = new Set();
		/** Port it listens on, assigned by the operating system on the first start */
		this.port = 0;
		/** How many connections it accepted so far */
		this.connections = 0;
	}

	/** Starts listening on 127.0.0.1, on the same port as before if it was started already */
	async start() {
		const server = net.createServer((socket) => {
			this.connections++;
			this.sockets.add(socket);
			socket.on("close", () => this.sockets.delete(socket));
			socket.on("error", () => {});
			// What blerp.js sends when noble is powered on
			this.send({ type: "connected" }, socket);
			this.send(
				{ type: "log", message: "starting scan for services []" },
				socket,
			);
			this.send(
				{ type: "driverState", driverState: "poweredOn" },
				socket,
			);
		});
		await new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(this.port, "127.0.0.1", () => resolve(undefined));
		});
		this.server = server;
		this.port = /** @type {net.AddressInfo} */ (server.address()).port;
	}

	/** Closes all connections and stops listening, like a server that is switched off */
	async stop() {
		for (const socket of this.sockets) socket.destroy();
		this.sockets.clear();
		const server = this.server;
		this.server = null;
		if (server)
			await new Promise((resolve) =>
				server.close(() => resolve(undefined)),
			);
	}

	/** Whether the adapter is connected */
	get connected() {
		return this.sockets.size > 0;
	}

	/**
	 * Sends a message to the connected adapter
	 *
	 * @param {any} message - The message, as scanProcess.ts sends it
	 * @param {net.Socket} [only] - Send it to this connection only
	 */
	send(message, only) {
		const line = JSON.stringify(message) + "\n";
		for (const socket of only ? [only] : this.sockets) socket.write(line);
	}

	/**
	 * Reports a received advertisement with service data, as noble describes it
	 *
	 * @param {string} address - MAC address, lowercase with colons
	 * @param {string} serviceUuid - 16 bit UUID as 4 hex chars, e.g. "fcd2"
	 * @param {string} hex - The service data
	 * @param {number} [rssi] - Signal strength
	 */
	discover(address, serviceUuid, hex, rssi = -70) {
		const id = address.replace(/:/g, "");
		this.send({
			type: "discover",
			peripheral: {
				id,
				uuid: id,
				address,
				addressType: "public",
				connectable: true,
				advertisement: {
					localName: undefined,
					serviceData: [
						{ uuid: serviceUuid, data: Buffer.from(hex, "hex") },
					],
					serviceUuids: [],
				},
				rssi,
			},
		});
	}
}

module.exports = { FakeScanServer };
