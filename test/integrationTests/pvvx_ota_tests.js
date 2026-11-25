// @ts-check

/**
 * pvvx Integration Test - firmware update of pvvx thermometers through a gateway
 *
 * The adapter loads firmware.json and the image from a local HTTP server (setting
 * pvvxFirmwareUrl), connects to the thermometer through a gateway that announced the feature
 * "writeSequence" (test.0, played by FakeGattGateway) and transfers the image with
 * gatt:writeSequence. The thermometer, including its update receiver, is simulated by
 * fakePvvxThermometer.js. After the end packet it "restarts": the gateway reports the
 * connection as ended, and the next connection reports the new version.
 */

const http = require("node:http");
const { expect } = require("chai");
const { buildTestImage } = require("../../build/drivers/pvvx/test-image");
const { FakeGattGateway } = require("./fakeGattGateway");
const { createPvvxHandler } = require("./fakePvvxThermometer");
const {
	NAMESPACE,
	PACKETS,
	allowNewDevices,
	deliver,
	getValue,
	sendToAdapter,
	startAdapter,
	stopAdapter,
	waitFor,
} = require("./helpers");

const DEVICE = "a4:c1:38:12:34:56";
const IMAGE = buildTestImage(4100);
const FIRMWARE_JSON = JSON.stringify({
	version: 0x60,
	custom: ["bin/test.bin", "?"],
});

/**
 * Serves firmware.json and the test image
 *
 * @returns {Promise<{ url: string, requests: string[], close: () => Promise<void> }>} The server
 */
async function startFirmwareServer() {
	/** @type {string[]} */
	const requests = [];
	const server = http.createServer((req, res) => {
		requests.push(req.url ?? "");
		if (req.url === "/firmware.json") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(FIRMWARE_JSON);
		} else if (req.url === "/bin/test.bin") {
			res.writeHead(200, { "content-type": "application/octet-stream" });
			res.end(IMAGE);
		} else {
			res.writeHead(404);
			res.end();
		}
	});
	await new Promise((resolve) =>
		server.listen(0, "127.0.0.1", () => resolve(undefined)),
	);
	const address = /** @type {import("node:net").AddressInfo} */ (
		server.address()
	);
	return {
		url: `http://127.0.0.1:${address.port}/`,
		requests,
		close: () =>
			new Promise((resolve) => server.close(() => resolve(undefined))),
	};
}

/**
 * Delivers the current advertisement of the thermometer every 5 s through proxy-og, like a real
 * proxy: the adapter only connects through gateways that received the device in the last 30 s.
 */
class Advertiser {
	/**
	 * @param {any} harness - Integration test harness
	 */
	constructor(harness) {
		this.harness = harness;
		/** The payload that is delivered */
		this.data = PACKETS.bthomeThermometer;
		this.timer = setInterval(() => void this.deliver(), 5000);
	}

	/** Delivers the advertisement now */
	async deliver() {
		await deliver(this.harness, "proxy-og", [
			{ address: DEVICE, rssi: -60, data: this.data },
		]).catch(() => {});
	}

	stop() {
		clearInterval(this.timer);
	}
}

/**
 * Announces proxy-og and lets it deliver the advertisements of the thermometer
 *
 * @param {any} harness - Integration test harness
 * @param {string[] | undefined} features - Features of the gateway
 * @returns {Promise<Advertiser>} Delivers the advertisements until it is stopped
 */
async function prepare(harness, features) {
	const response = await sendToAdapter(harness, "gateway:announce", {
		protocol: "ble-gateway/1",
		gateways: [
			{
				gatewayId: "proxy-og",
				connect: true,
				freeSlots: 3,
				slotLimit: 3,
				...(features ? { features } : {}),
			},
		],
	});
	expect(response.error).to.be.null;
	// The battery state only exists for recorded devices
	await allowNewDevices(harness);
	const advertiser = new Advertiser(harness);
	await advertiser.deliver();
	await waitFor(
		async () => (await getValue(harness, `${DEVICE}.battery`)) === 100,
		"the battery state",
	);
	return advertiser;
}

/**
 * Presses a button of the adapter
 *
 * @param {any} harness - Integration test harness
 * @param {string} id - ID relative to the namespace
 */
async function press(harness, id) {
	await harness.states.setStateAsync(`${NAMESPACE}.${id}`, {
		val: true,
		ack: false,
	});
}

/**
 * Presses the update button and waits until the update ended
 *
 * @param {any} harness - Integration test harness
 * @param {string} expected - "done" or "failed"
 */
async function runUpdate(harness, expected) {
	// The status of the update before, so the end of this one can be told
	await harness.states.setStateAsync(
		`${NAMESPACE}.${DEVICE}.pvvx.firmwareStatus`,
		{ val: "idle", ack: true },
	);
	await press(harness, `${DEVICE}.pvvx.firmwareUpdate`);
	let status;
	try {
		await waitFor(
			async () => {
				status = await getValue(
					harness,
					`${DEVICE}.pvvx.firmwareStatus`,
				);
				return status === "done" || status === "failed";
			},
			"the end of the update",
			120000,
		);
	} finally {
		const error = await getValue(harness, `${DEVICE}.pvvx.firmwareError`);
		expect(status, `firmwareError: ${error}`).to.equal(expected);
	}
}

/** @param {(name: string, fn: (getHarness: () => any) => void) => void} suite */
exports.runTests = function (suite) {
	suite("pvvx - firmware update", (getHarness) => {
		/** @type {any} */
		let harness;
		/** @type {FakeGattGateway} */
		let gateway;
		/** @type {ReturnType<typeof createPvvxHandler>} */
		let thermometer;
		/** @type {Awaited<ReturnType<typeof startFirmwareServer>>} */
		let server;
		/** @type {Advertiser} */
		let advertiser;

		before(async function () {
			this.timeout(60000);
			harness = getHarness();
			server = await startFirmwareServer();
			await startAdapter(harness, {
				plugins: "bthome",
				pvvxDevices: DEVICE,
				pvvxFirmwareCheck: false,
				pvvxFirmwareUrl: server.url,
			});
			gateway = new FakeGattGateway(harness);
			thermometer = createPvvxHandler({
				clock: Math.floor(Date.now() / 1000),
			});
			thermometer.onDisconnect = (address) =>
				gateway.dropConnection(address);
			gateway.setWriteHandler(thermometer);
			gateway.setReadHandler(thermometer.readHandler);
			advertiser = await prepare(harness, ["writeSequence"]);
		});

		after(async () => {
			advertiser?.stop();
			await stopAdapter(harness);
			await server?.close();
		});

		it("creates the firmware states", async function () {
			this.timeout(30000);
			await waitFor(
				// The test installation keeps its states between local runs: any status of an
				// update that is not running
				async () =>
					["idle", "done", "failed"].includes(
						await getValue(
							harness,
							`${DEVICE}.pvvx.firmwareStatus`,
						),
					),
				"the firmware states",
			);
			for (const id of [
				`${DEVICE}.pvvx.firmwareAvailable`,
				`${DEVICE}.pvvx.firmwareUpdate`,
				`${DEVICE}.pvvx.firmwareProgress`,
				`${DEVICE}.pvvx.firmwareStatus`,
				`${DEVICE}.pvvx.firmwareError`,
				"pvvx.checkFirmware",
				"pvvx.updateAll",
			]) {
				expect(
					await harness.objects.getObjectAsync(`${NAMESPACE}.${id}`),
					id,
				).to.be.ok;
			}
		});

		it("shows a newer firmware after a check", async function () {
			this.timeout(60000);
			// The time sync reads version and hardware ID
			await press(harness, `${DEVICE}.pvvx.syncTime`);
			await waitFor(
				async () =>
					(await getValue(
						harness,
						`${DEVICE}.pvvx.firmwareVersion`,
					)) === "5.9",
				"the firmware version",
				30000,
			);

			await press(harness, "pvvx.checkFirmware");

			await waitFor(
				async () =>
					(await getValue(
						harness,
						`${DEVICE}.pvvx.firmwareAvailable`,
					)) === "6.0",
				"the newer firmware",
				30000,
			);
			expect(server.requests).to.deep.equal(["/firmware.json"]);
		});

		it("updates the firmware", async function () {
			this.timeout(150000);
			const commandsBefore = gateway.commands.length;
			const timeWritesBefore = thermometer.writes.length;

			await runUpdate(harness, "done");

			expect(thermometer.ota.finished).to.equal(true);
			expect(thermometer.ota.dataPackets).to.equal(257);
			expect(
				Buffer.concat(thermometer.ota.received)
					.subarray(0, IMAGE.length)
					.equals(IMAGE),
			).to.equal(true);
			expect(
				await getValue(harness, `${DEVICE}.pvvx.firmwareVersion`),
			).to.equal("6.0");
			expect(
				await getValue(harness, `${DEVICE}.pvvx.firmwareAvailable`),
			).to.equal("");
			expect(
				await getValue(harness, `${DEVICE}.pvvx.firmwareProgress`),
			).to.equal(100);
			expect(
				await getValue(harness, `${DEVICE}.pvvx.firmwareError`),
			).to.equal("");

			const sequences = gateway.commands
				.slice(commandsBefore)
				.filter((c) => c.command === "gatt:writeSequence")
				.map((c) => c.message);
			expect(sequences).to.have.lengthOf(33);
			expect(sequences.every((m) => m.data.length <= 8)).to.equal(true);
			expect(sequences.every((m) => m.withResponse === false)).to.equal(
				true,
			);
			expect(sequences.every((m) => m.handle === 42)).to.equal(true);

			// Then the clock is set again
			await waitFor(
				() =>
					thermometer.writes
						.slice(timeWritesBefore)
						.some((w) => /^23[0-9a-f]{8}$/.test(w)),
				"the time sync after the update",
				30000,
			);
		});

		it("keeps the old firmware when the connection is lost", async function () {
			this.timeout(300000);
			const config = Buffer.from(thermometer.configResponse, "hex");
			config[1] = 0x59;
			thermometer.configResponse = config.toString("hex");
			thermometer.ota.dropAfterPackets = 40;

			await runUpdate(harness, "failed");

			expect(
				String(await getValue(harness, `${DEVICE}.pvvx.firmwareError`)),
			).to.match(/^NOT_CONNECTED: /);
			expect(thermometer.ota.finished).to.equal(false);

			thermometer.ota.dropAfterPackets = undefined;
			await runUpdate(harness, "done");
			expect(thermometer.ota.finished).to.equal(true);
		});

		it("refuses a device with a low battery", async function () {
			this.timeout(60000);
			advertiser.data = PACKETS.bthomeThermometerLowBattery;
			await advertiser.deliver();
			await waitFor(
				async () =>
					(await getValue(harness, `${DEVICE}.battery`)) === 20,
				"the low battery",
			);
			const commandsBefore = gateway.commands.length;

			await press(harness, `${DEVICE}.pvvx.firmwareUpdate`);
			await waitFor(
				async () =>
					String(
						await getValue(harness, `${DEVICE}.pvvx.firmwareError`),
					).startsWith("BATTERY_LOW: "),
				"the battery error",
				30000,
			);
			expect(
				gateway.commands
					.slice(commandsBefore)
					.filter((c) => c.command === "gatt:connect"),
			).to.deep.equal([]);
		});
	});

	suite("pvvx - firmware update without a capable gateway", (getHarness) => {
		/** @type {any} */
		let harness;
		/** @type {FakeGattGateway} */
		let gateway;
		/** @type {Awaited<ReturnType<typeof startFirmwareServer>>} */
		let server;
		/** @type {Advertiser} */
		let advertiser;

		before(async function () {
			this.timeout(60000);
			harness = getHarness();
			server = await startFirmwareServer();
			await startAdapter(harness, {
				plugins: "bthome",
				pvvxDevices: DEVICE,
				pvvxFirmwareCheck: false,
				pvvxFirmwareUrl: server.url,
			});
			gateway = new FakeGattGateway(harness);
			// Can connect, but has no writeSequence
			advertiser = await prepare(harness, undefined);
		});

		after(async () => {
			advertiser?.stop();
			await stopAdapter(harness);
			await server?.close();
		});

		it("reports that no gateway can update the firmware", async function () {
			this.timeout(60000);
			await waitFor(
				// The test installation keeps its states between local runs: any status of an
				// update that is not running
				async () =>
					["idle", "done", "failed"].includes(
						await getValue(
							harness,
							`${DEVICE}.pvvx.firmwareStatus`,
						),
					),
				"the firmware states",
			);

			await press(harness, `${DEVICE}.pvvx.firmwareUpdate`);

			await waitFor(
				async () =>
					String(
						await getValue(harness, `${DEVICE}.pvvx.firmwareError`),
					).startsWith("NO_GATEWAY: "),
				"the error",
				30000,
			);
			expect(gateway.log).to.not.include("gatt:connect proxy-og");
		});
	});
};
