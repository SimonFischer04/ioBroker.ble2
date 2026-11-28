// @ts-check

/**
 * pvvx Integration Test - setting the clock of pvvx thermometers through a gateway
 *
 * The adapter connects to the thermometer through a gateway another instance announced (test.0,
 * played by FakeGattGateway), reads the configuration (0x55) and the clock (0x23) and sets the
 * clock (0x23 + value). The thermometer is simulated by the write handler of fakePvvxThermometer.js.
 *
 * The adapter runs in the fixed time zone UTC+3 without summer time (TZ "Etc/GMT-3", the sign is
 * reversed in POSIX). The expected clock value is therefore the Unix time + 10800 s, whatever the
 * time zone of the test process. Summer time is covered by the unit tests.
 */

const { expect } = require("chai");
const { FakeGattGateway } = require("./fakeGattGateway");
const { createPvvxHandler } = require("./fakePvvxThermometer");
const {
	NAMESPACE,
	PACKETS,
	delay,
	deliver,
	getValue,
	sendToAdapter,
	startAdapter,
	stopAdapter,
	waitFor,
} = require("./helpers");

/** @import { IntegrationTestHarness } from "@iobroker/testing" */

const DEVICE = "a4:c1:38:12:34:56";
const ENV = { TZ: "Etc/GMT-3" };
const UTC_OFFSET_S = 3 * 3600;
const STATES = [
	"syncTime",
	"lastTimeSync",
	"timeDeviation",
	"firmwareVersion",
	"hardwareId",
	"lastError",
];

/** @returns {number} The clock value the adapter should set now */
function expectedClock() {
	return Math.floor(Date.now() / 1000) + UTC_OFFSET_S;
}

/**
 * Announces proxy-og as gateway that can connect (unless announce is false) and delivers an
 * advertisement of the thermometer through the gateway
 *
 * @param {IntegrationTestHarness} harness - Integration test harness
 * @param {string} gatewayId - The gateway
 * @param {boolean} announce - Whether the gateway announces itself
 */
async function prepare(harness, gatewayId, announce) {
	if (announce) {
		const response = await sendToAdapter(harness, "gateway:announce", {
			protocol: "ble-gateway/1",
			gateways: [
				{ gatewayId, connect: true, freeSlots: 3, slotLimit: 3 },
			],
		});
		expect(response.error).to.be.null;
	}
	await deliver(harness, gatewayId, [
		{ address: DEVICE, rssi: -60, data: PACKETS.bthomeThermometer },
	]);
}

/**
 * Presses the button pvvx.syncTime
 *
 * @param {IntegrationTestHarness} harness - Integration test harness
 */
async function pressButton(harness) {
	await harness.states.setStateAsync(`${NAMESPACE}.${DEVICE}.pvvx.syncTime`, {
		val: true,
		ack: false,
	});
}

/**
 * @param {IntegrationTestHarness} harness - Integration test harness
 * @returns {Promise<boolean>} Whether all pvvx objects of the thermometer exist
 */
async function objectsExist(harness) {
	for (const id of [
		DEVICE,
		`${DEVICE}.pvvx`,
		...STATES.map((s) => `${DEVICE}.pvvx.${s}`),
	]) {
		if (!(await harness.objects.getObjectAsync(`${NAMESPACE}.${id}`))) {
			return false;
		}
	}
	return true;
}

/**
 * Defines the suites of this file
 *
 * @param {(name: string, fn: (getHarness: () => IntegrationTestHarness) => void) => void} suite - Defines a suite with a fresh harness
 */
exports.runTests = function (suite) {
	suite("pvvx - setting the clock", (getHarness) => {
		let harness;
		let gateway;
		let thermometer;

		before(async function () {
			this.timeout(60000);
			harness = getHarness();
			await startAdapter(
				harness,
				{
					plugins: "bthome, atc",
					pvvxDevices: "A4:C1:38:12:34:56",
					pvvxSyncInterval: 24,
				},
				ENV,
			);
			gateway = new FakeGattGateway(harness);
			await prepare(harness, "proxy-og", true);
		});

		beforeEach(() => {
			gateway.reset();
			thermometer = createPvvxHandler({
				clock: expectedClock() - 3600,
			});
			gateway.setWriteHandler(thermometer);
		});

		after(() => stopAdapter(harness));

		/**
		 * Presses the button and waits until the sync succeeded
		 *
		 * @returns {Promise<void>}
		 */
		async function syncByButton() {
			const before = await getValue(
				harness,
				`${DEVICE}.pvvx.lastTimeSync`,
			);
			await pressButton(harness);
			await waitFor(
				async () =>
					(await getValue(harness, `${DEVICE}.pvvx.lastTimeSync`)) !==
					before,
				"the time sync",
				30000,
			);
		}

		/** Checks what the thermometer got and the states after a successful sync */
		async function expectSuccess() {
			const writes = gateway.commands
				.filter((c) => c.command === "gatt:write")
				.map((c) => c.message);
			expect(writes.map((w) => w.handle)).to.deep.equal([32, 32, 32]);
			expect(writes.map((w) => w.withResponse)).to.deep.equal([
				false,
				false,
				false,
			]);
			expect(thermometer.writes.slice(0, 2)).to.deep.equal(["55", "23"]);
			expect(thermometer.writes[2]).to.match(/^23[0-9a-f]{8}$/);
			expect(thermometer.writes).to.have.lengthOf(3);

			const set = Buffer.from(thermometer.writes[2], "hex").readUInt32LE(
				1,
			);
			expect(Math.abs(set - expectedClock())).to.be.at.most(2);

			const deviation = await getValue(
				harness,
				`${DEVICE}.pvvx.timeDeviation`,
			);
			expect(Math.abs(deviation + 3600)).to.be.at.most(2);
			expect(
				await getValue(harness, `${DEVICE}.pvvx.firmwareVersion`),
			).to.equal("5.9");
			expect(
				await getValue(harness, `${DEVICE}.pvvx.hardwareId`),
			).to.equal(0);
			expect(
				await getValue(harness, `${DEVICE}.pvvx.lastError`),
			).to.equal("");
			const lastSync = await getValue(
				harness,
				`${DEVICE}.pvvx.lastTimeSync`,
			);
			expect(Date.now() - lastSync).to.be.within(0, 30000);

			await waitFor(
				() => gateway.log.includes("gatt:disconnect proxy-og"),
				"the connection to be closed",
			);
		}

		it("creates the states of a configured device", async function () {
			this.timeout(30000);
			await waitFor(() => objectsExist(harness), "the pvvx objects");

			expect(
				await getValue(harness, `${DEVICE}.pvvx.lastError`),
			).to.equal(undefined);
			// The first sync waits a minute for the gateways
			expect(gateway.log).to.not.include("gatt:connect proxy-og");
		});

		it("sets the clock when the button is pressed", async function () {
			this.timeout(60000);

			await syncByButton();

			await expectSuccess();
			const button = await harness.states.getStateAsync(
				`${NAMESPACE}.${DEVICE}.pvvx.syncTime`,
			);
			expect(button).to.include({ val: false, ack: true });
		});

		it("skips measurements the device sends in between", async function () {
			this.timeout(60000);
			thermometer.beforeEachAnswer = ["330b0c2e09f41364"];

			await syncByButton();

			await expectSuccess();
		});

		it("reports a device that does not answer like a pvvx firmware", async function () {
			this.timeout(60000);
			thermometer.configResponse = "55ff";

			await pressButton(harness);

			await waitFor(
				async () =>
					String(
						await getValue(harness, `${DEVICE}.pvvx.lastError`),
					).startsWith("UNEXPECTED_ANSWER: "),
				"the error",
				30000,
			);
			expect(thermometer.writes).to.deep.equal(["55"]);
		});
	});

	suite("pvvx - device not reachable", (getHarness) => {
		let harness;
		let gateway;

		before(async function () {
			this.timeout(60000);
			harness = getHarness();
			await startAdapter(
				harness,
				{
					plugins: "bthome, atc",
					pvvxDevices: "A4:C1:38:12:34:56",
					pvvxSyncInterval: 24,
				},
				ENV,
			);
			gateway = new FakeGattGateway(harness);
			// Received, but by a gateway that cannot connect
			await prepare(harness, "proxy-keller", false);
		});

		after(() => stopAdapter(harness));

		it("reports that no gateway can connect", async function () {
			this.timeout(60000);
			await waitFor(() => objectsExist(harness), "the pvvx objects");

			await pressButton(harness);

			await waitFor(
				async () =>
					String(
						await getValue(harness, `${DEVICE}.pvvx.lastError`),
					).startsWith("NO_GATEWAY: "),
				"the error",
				30000,
			);
			expect(gateway.log).to.not.include("gatt:connect proxy-keller");
		});
	});

	suite("pvvx - invalid configuration", (getHarness) => {
		let harness;

		before(async function () {
			this.timeout(60000);
			harness = getHarness();
			await startAdapter(
				harness,
				{
					plugins: "bthome, atc",
					pvvxDevices: "a4:c1:38:12:34:56, not-a-mac",
				},
				ENV,
			);
		});

		after(() => stopAdapter(harness));

		it("ignores invalid addresses and keeps running", async function () {
			this.timeout(30000);
			await waitFor(() => objectsExist(harness), "the pvvx objects");
			expect(harness.isAdapterRunning()).to.equal(true);
			const response = await sendToAdapter(harness, "getGateways", {});
			expect(response.error).to.be.null;
		});
	});

	suite("pvvx - no devices configured", (getHarness) => {
		let harness;

		before(async function () {
			this.timeout(60000);
			harness = getHarness();
			await startAdapter(harness, {}, ENV);
		});

		after(() => stopAdapter(harness));

		it("creates no pvvx objects", async function () {
			this.timeout(30000);
			const objects = await harness.objects.getObjectListAsync({
				startkey: `${NAMESPACE}.`,
				endkey: `${NAMESPACE}.香`,
			});
			const ids = objects.rows.map((row) => row.id);
			expect(ids.length, "objects of the instance").to.be.greaterThan(0);
			expect(ids.filter((id) => id.includes(".pvvx"))).to.deep.equal([]);
		});
	});

	suite("pvvx - plugin not selected", (getHarness) => {
		let harness;

		before(async function () {
			this.timeout(60000);
			harness = getHarness();
			// Devices are configured, but the plugin "atc" is not selected
			await startAdapter(
				harness,
				{ plugins: "bthome", pvvxDevices: DEVICE },
				ENV,
			);
		});

		after(() => stopAdapter(harness));

		it("does not start the time sync", async function () {
			this.timeout(30000);
			await delay(2000);
			const objects = await harness.objects.getObjectListAsync({
				startkey: `${NAMESPACE}.`,
				endkey: `${NAMESPACE}.\u9999`,
			});
			const ids = objects.rows.map((row) => row.id);
			expect(ids.filter((id) => id.includes(".pvvx"))).to.deep.equal([]);
		});
	});
};
