// @ts-check

/**
 * A pvvx thermometer behind FakeGattGateway: builds a write handler for setWriteHandler() that
 * answers the commands 0x55 (configuration) and 0x23 (clock) on handle 32 with notifications,
 * like FakePvvxDevice of the unit tests (src/drivers/pvvx/fake-pvvx-device.ts).
 */

const {
	crc16Modbus,
	validateImage,
} = require("../../build/drivers/pvvx/ota-protocol");

const COMMAND_HANDLE = 32;
const OTA_HANDLE = 42;

/**
 * @typedef {object} PvvxOta
 * @property {boolean} started - 01 ff was received
 * @property {Buffer[]} received - The data of the packets received so far, in order
 * @property {number} status - Status byte read from handle 42
 * @property {boolean} finished - A valid image and end packet were received
 * @property {number} newVersion - Version the device reports after a successful update
 * @property {{after: number, status: number} | undefined} failStatusAfterPackets - From this data packet on, the status is set
 * @property {number | undefined} dropAfterPackets - After this many data packets of an update the connection ends
 * @property {number} dataPackets - Data packets of the current update
 * @property {number} sequenceWrites - Every write to handle 42
 */

/**
 * @typedef {object} PvvxThermometer
 * @property {number} clock - Value of the device clock, local time as Unix seconds
 * @property {number} lastSet - When the clock was set last
 * @property {boolean} timeAdjust - Whether the answers to 0x23 carry lastSet (9 bytes)
 * @property {boolean} ignoreSetTime - Whether setting the clock is ignored
 * @property {string} configResponse - Answer to 0x55, hex
 * @property {string[]} beforeEachAnswer - Notifications sent before every answer, hex, e.g. measurements
 * @property {string[]} writes - Every write to handle 32, hex
 * @property {PvvxOta} ota - The update receiver
 * @property {(address: string) => void} onDisconnect - Called when the device ends the connection
 * @property {(address: string, handle: number) => string | undefined} readHandler - For FakeGattGateway.setReadHandler()
 */

/**
 * @param {Partial<Omit<PvvxThermometer, "writes">>} [options] - Initial state
 * @returns {((address: string, handle: number, dataHex: string) => string[] | undefined) & PvvxThermometer} The handler, its state can be changed
 */
function createPvvxHandler(options = {}) {
	const state = {
		clock: 0,
		lastSet: 0,
		timeAdjust: false,
		ignoreSetTime: false,
		// Firmware 5.9, hardware ID 0
		configResponse: "5559000000000a048b003700",
		beforeEachAnswer: [],
		...options,
		writes: [],
		ota: {
			started: false,
			received: [],
			status: 0,
			finished: false,
			newVersion: 0x60,
			failStatusAfterPackets: undefined,
			dropAfterPackets: undefined,
			dataPackets: 0,
			sequenceWrites: 0,
		},
		onDisconnect: () => {},
		readHandler: (_address, handle) =>
			handle === OTA_HANDLE
				? Buffer.from([thermometer.ota.status]).toString("hex")
				: undefined,
	};

	/**
	 * A write to the update characteristic, handled like the Telink firmware
	 *
	 * @param {string} address - The device
	 * @param {Buffer} data - The packet
	 */
	const writeOta = (address, data) => {
		const ota = thermometer.ota;
		ota.sequenceWrites++;
		const setStatus = (status) => {
			if (ota.status === 0) {
				ota.status = status;
			}
		};
		if (data.length === 2 && data[0] === 0x01 && data[1] === 0xff) {
			// A new update starts from the beginning
			ota.started = true;
			ota.finished = false;
			ota.received = [];
			ota.status = 0;
			ota.dataPackets = 0;
		} else if (data.length === 20) {
			if (
				ota.dropAfterPackets !== undefined &&
				ota.dataPackets >= ota.dropAfterPackets
			) {
				thermometer.onDisconnect(address);
				return;
			}
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
			if (fail && ota.dataPackets >= fail.after) {
				ota.status = fail.status;
			}
		} else if (data.length === 6 && data[0] === 0x02 && data[1] === 0xff) {
			if (data.readUInt16LE(2) !== ota.received.length - 1) {
				setStatus(4);
			} else if (
				"problem" in validateImage(Buffer.concat(ota.received))
			) {
				setStatus(6);
			} else if (ota.status === 0) {
				ota.finished = true;
				const config = Buffer.from(thermometer.configResponse, "hex");
				config[1] = ota.newVersion;
				thermometer.configResponse = config.toString("hex");
				// The device restarts with the new firmware
				thermometer.onDisconnect(address);
			}
		}
	};

	/** @returns {string} The answer to 0x23 with the current clock */
	const timeResponse = () => {
		const answer = Buffer.alloc(thermometer.timeAdjust ? 9 : 5);
		answer[0] = 0x23;
		answer.writeUInt32LE(thermometer.clock >>> 0, 1);
		if (thermometer.timeAdjust) {
			answer.writeUInt32LE(thermometer.lastSet >>> 0, 5);
		}
		return answer.toString("hex");
	};

	/**
	 * @param {string} _address - The device
	 * @param address
	 * @param {number} handle - Handle written to
	 * @param {string} dataHex - The data
	 * @returns {string[] | undefined} The notifications
	 */
	const handler = (address, handle, dataHex) => {
		if (handle === OTA_HANDLE) {
			writeOta(address, Buffer.from(dataHex, "hex"));
			return undefined;
		}
		if (handle !== COMMAND_HANDLE) {
			return undefined;
		}
		thermometer.writes.push(dataHex);
		const data = Buffer.from(dataHex, "hex");
		const command = data[0];
		let answer;
		if (command === 0x55) {
			answer = thermometer.configResponse;
		} else if (command === 0x23 && data.length >= 5) {
			if (!thermometer.ignoreSetTime) {
				thermometer.clock = data.readUInt32LE(1);
				thermometer.lastSet = thermometer.clock;
			}
			answer = timeResponse();
		} else if (command === 0x23) {
			answer = timeResponse();
		} else {
			answer = Buffer.from([command, 0xff]).toString("hex");
		}
		return [...thermometer.beforeEachAnswer, answer];
	};
	// The state lives on the handler, so the tests can change it
	const thermometer = Object.assign(handler, state);
	return thermometer;
}

module.exports = { createPvvxHandler, COMMAND_HANDLE, OTA_HANDLE };
