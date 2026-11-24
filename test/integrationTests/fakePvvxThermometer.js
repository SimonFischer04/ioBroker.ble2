// @ts-check

/**
 * A pvvx thermometer behind FakeGattGateway: builds a write handler for setWriteHandler() that
 * answers the commands 0x55 (configuration) and 0x23 (clock) on handle 32 with notifications,
 * like FakePvvxDevice of the unit tests (src/drivers/pvvx/fake-pvvx-device.ts).
 */

const COMMAND_HANDLE = 32;

/**
 * @typedef {object} PvvxThermometer
 * @property {number} clock - Value of the device clock, local time as Unix seconds
 * @property {number} lastSet - When the clock was set last
 * @property {boolean} timeAdjust - Whether the answers to 0x23 carry lastSet (9 bytes)
 * @property {boolean} ignoreSetTime - Whether setting the clock is ignored
 * @property {string} configResponse - Answer to 0x55, hex
 * @property {string[]} beforeEachAnswer - Notifications sent before every answer, hex, e.g. measurements
 * @property {string[]} writes - Every write to handle 32, hex
 */

/**
 * @param {Partial<Omit<PvvxThermometer, "writes">>} [options] - Initial state
 * @returns {((address: string, handle: number, dataHex: string) => string[] | undefined) & PvvxThermometer} The handler, its state can be changed
 */
function createPvvxHandler(options = {}) {
	/** @type {PvvxThermometer} */
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
	 * @param {number} handle - Handle written to
	 * @param {string} dataHex - The data
	 * @returns {string[] | undefined} The notifications
	 */
	const handler = (_address, handle, dataHex) => {
		if (handle !== COMMAND_HANDLE) return undefined;
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

module.exports = { createPvvxHandler, COMMAND_HANDLE };
