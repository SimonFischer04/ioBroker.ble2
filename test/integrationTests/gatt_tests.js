// @ts-check

/**
 * GATT Integration Test - connections through gateways of other adapters
 *
 * Other adapters run discoverServices, readCharacteristic and writeCharacteristic on ble2.0. The
 * adapter connects through a gateway another instance announced (here test.0, played by
 * FakeGattGateway) and sends it the gatt:* commands. The device is the one the gateways deliver
 * advertisements of: the gateway with the best signal is tried first.
 */

const { expect } = require("chai");
const { FakeGattGateway, SERVICES } = require("./fakeGattGateway");
const {
	PACKETS,
	deliver,
	getMessageClient,
	sendToAdapter,
	startAdapter,
	stopAdapter,
	waitFor,
} = require("./helpers");

const DEVICE = "a4:c1:38:12:34:56";
const VALUE = "2301020304";

/**
 * Announces the gateways and delivers an advertisement of the device through each of them
 *
 * @param {any} harness - Integration test harness
 * @param {{gatewayId: string, rssi: number, connect?: boolean, freeSlots?: number}[]} gateways - The gateways
 * @param {string} [address] - The device
 * @returns {Promise<number>} The epoch the adapter answered with
 */
async function prepare(harness, gateways, address = DEVICE) {
	const response = await sendToAdapter(harness, "gateway:announce", {
		protocol: "ble-gateway/1",
		gateways: gateways
			.filter((g) => g.connect !== false)
			.map(({ gatewayId, freeSlots }) => ({
				gatewayId,
				connect: true,
				...(freeSlots === undefined ? {} : { freeSlots, slotLimit: 3 }),
			})),
	});
	expect(response.error).to.be.null;
	for (const { gatewayId, rssi } of gateways) {
		await deliver(harness, gatewayId, [
			{ address, rssi, data: PACKETS.bthomeThermometer },
		]);
	}
	return response.result.epoch;
}

/**
 * @param {any} harness - Integration test harness
 * @param {Record<string, any>} [message] - Changes to the request
 * @returns {Promise<any>} The answer
 */
function read(harness, message = {}) {
	return sendToAdapter(
		harness,
		"readCharacteristic",
		{
			address: DEVICE,
			service: "1f10",
			characteristic: "1f1f",
			...message,
		},
		40000,
	);
}

const TWO_GATEWAYS = [
	{ gatewayId: "proxy-og", rssi: -55 },
	{ gatewayId: "proxy-keller", rssi: -85 },
];

/** @param {(name: string, fn: (getHarness: () => any) => void) => void} suite */
exports.runTests = function (suite) {
	suite("GATT - reading and writing through a gateway", (getHarness) => {
		let harness;
		let gateway;

		before(async function () {
			this.timeout(60000);
			harness = getHarness();
			await startAdapter(harness, { plugins: "bthome" });
			gateway = new FakeGattGateway(harness);
		});

		beforeEach(() => {
			gateway.reset();
			gateway.values.set(32, VALUE);
		});

		after(() => stopAdapter(harness));

		it("reads a characteristic", async function () {
			this.timeout(30000);
			const epoch = await prepare(harness, TWO_GATEWAYS);

			const response = await read(harness);

			expect(response).to.deep.equal({
				error: null,
				result: { data: Buffer.from(VALUE, "hex").toString("base64") },
			});
			await waitFor(
				() => gateway.commands.length === 4,
				"the connection to be closed",
			);
			expect(gateway.log).to.deep.equal([
				"gatt:connect proxy-og",
				"gatt:getServices proxy-og",
				"gatt:read proxy-og",
				"gatt:disconnect proxy-og",
			]);
			expect(gateway.commands[0].message).to.deep.equal({
				gatewayId: "proxy-og",
				address: DEVICE,
				addressType: "public",
				epoch,
			});
			expect(gateway.commands[2].message).to.deep.equal({
				gatewayId: "proxy-og",
				address: DEVICE,
				handle: 32,
			});
		});

		it("accepts the full UUID as well", async function () {
			this.timeout(30000);
			await prepare(harness, TWO_GATEWAYS);

			const response = await read(harness, {
				address: DEVICE.toUpperCase(),
				service: "00001F10-0000-1000-8000-00805F9B34FB",
				characteristic: "00001F1F00001000800000805F9B34FB",
			});

			expect(response.result).to.deep.equal({
				data: Buffer.from(VALUE, "hex").toString("base64"),
			});
		});

		it("writes a characteristic", async function () {
			this.timeout(30000);
			await prepare(harness, TWO_GATEWAYS);

			const response = await sendToAdapter(
				harness,
				"writeCharacteristic",
				{
					address: DEVICE,
					service: "1f10",
					characteristic: "1f1f",
					data: Buffer.from("5501", "hex").toString("base64"),
				},
			);
			expect(response).to.deep.equal({ error: null, result: {} });
			expect(gateway.values.get(32)).to.equal("5501");
			const write = gateway.commands.find(
				(c) => c.command === "gatt:write",
			);
			expect(write?.message).to.deep.equal({
				gatewayId: "proxy-og",
				address: DEVICE,
				handle: 32,
				data: "VQE=",
				withResponse: true,
			});

			await sendToAdapter(harness, "writeCharacteristic", {
				address: DEVICE,
				service: "1f10",
				characteristic: "1f1f",
				data: "Iw==",
				withResponse: false,
			});
			const writes = gateway.commands.filter(
				(c) => c.command === "gatt:write",
			);
			expect(writes[1].message.withResponse).to.equal(false);
			expect(gateway.values.get(32)).to.equal("23");
		});

		it("lists the services of a device", async function () {
			this.timeout(30000);
			await prepare(harness, TWO_GATEWAYS);

			const response = await sendToAdapter(harness, "discoverServices", {
				address: DEVICE,
			});

			expect(response).to.deep.equal({
				error: null,
				result: { services: SERVICES },
			});
		});

		it("runs two requests for the same device one after the other", async function () {
			this.timeout(30000);
			await prepare(harness, TWO_GATEWAYS);
			gateway.connectDelayMs["proxy-og"] = 300;

			const [one, two] = await Promise.all([
				read(harness),
				read(harness),
			]);

			expect(one.error).to.be.null;
			expect(two.error).to.be.null;
			expect(gateway.maxOpen.get(DEVICE)).to.equal(1);
			expect(
				gateway.log.filter((l) => l.startsWith("gatt:connect")),
			).to.have.length(2);
		});

		it("disconnects when the characteristic does not exist", async function () {
			this.timeout(30000);
			await prepare(harness, TWO_GATEWAYS);

			const response = await read(harness, { characteristic: "2a00" });

			expect(response.error.code).to.equal("GATT_ERROR");
			expect(response.error.message).to.include(
				"00002a00-0000-1000-8000-00805f9b34fb",
			);
			await waitFor(
				() => gateway.open.size === 0,
				"the connection to be closed",
			);
		});

		it("rejects invalid requests without connecting", async function () {
			this.timeout(30000);
			await prepare(harness, TWO_GATEWAYS);

			for (const [command, message] of [
				[
					"readCharacteristic",
					{
						address: "not-a-mac",
						service: "1f10",
						characteristic: "1f1f",
					},
				],
				[
					"readCharacteristic",
					{ address: DEVICE, service: "xyz", characteristic: "1f1f" },
				],
				["discoverServices", "a4:c1:38:12:34:56"],
				[
					"writeCharacteristic",
					{
						address: DEVICE,
						service: "1f10",
						characteristic: "1f1f",
						data: "not base64!",
					},
				],
				[
					"writeCharacteristic",
					{
						address: DEVICE,
						service: "1f10",
						characteristic: "1f1f",
						data: "AQ==",
						withResponse: "yes",
					},
				],
			]) {
				const response = await sendToAdapter(harness, command, message);
				expect(response.error?.code, JSON.stringify(message)).to.equal(
					"INVALID_PAYLOAD",
				);
			}
			expect(gateway.commands).to.deep.equal([]);
		});
	});

	suite("GATT - choosing a gateway", (getHarness) => {
		let harness;
		let gateway;

		before(async function () {
			this.timeout(60000);
			harness = getHarness();
			await startAdapter(harness, { plugins: "bthome" });
			gateway = new FakeGattGateway(harness);
		});

		beforeEach(() => {
			gateway.reset();
			gateway.values.set(32, VALUE);
		});

		after(() => stopAdapter(harness));

		it("uses the next gateway when the best one cannot connect", async function () {
			this.timeout(30000);
			await prepare(harness, TWO_GATEWAYS);
			gateway.failConnect["proxy-og"] = "CONNECT_FAILED";

			const response = await read(harness);

			expect(response.error).to.be.null;
			expect(
				gateway.log.filter((l) => l.startsWith("gatt:connect")),
			).to.deep.equal([
				"gatt:connect proxy-og",
				"gatt:connect proxy-keller",
			]);
		});

		it("does not use a gateway without free slots", async function () {
			this.timeout(30000);
			await prepare(harness, [
				{ gatewayId: "proxy-og", rssi: -55, freeSlots: 0 },
				{ gatewayId: "proxy-keller", rssi: -85, freeSlots: 3 },
			]);

			const response = await read(harness);

			expect(response.error).to.be.null;
			expect(
				gateway.log.filter((l) => l.startsWith("gatt:connect")),
			).to.deep.equal(["gatt:connect proxy-keller"]);
		});

		it("does not use a gateway that cannot connect", async function () {
			this.timeout(30000);
			const passiveOnly = "a4:c1:38:00:00:07";
			await prepare(
				harness,
				[{ gatewayId: "proxy-passive", rssi: -40, connect: false }],
				passiveOnly,
			);

			const response = await read(harness, { address: passiveOnly });

			expect(response.error.code).to.equal("NO_GATEWAY");
			expect(gateway.commands).to.deep.equal([]);
		});

		it("reports a device nobody receives", async function () {
			this.timeout(30000);

			const response = await read(harness, {
				address: "a4:c1:38:99:99:99",
			});

			expect(response.error).to.deep.equal({
				code: "NO_GATEWAY",
				message:
					"No gateway that can connect receives a4:c1:38:99:99:99",
			});
		});
	});

	suite("GATT - when things go wrong", (getHarness) => {
		let harness;
		let gateway;

		before(async function () {
			this.timeout(60000);
			harness = getHarness();
			// The default gateway timeout: the gateway must not go offline while a request waits
			await startAdapter(harness, { plugins: "bthome" });
			gateway = new FakeGattGateway(harness);
		});

		beforeEach(() => {
			gateway.reset();
			gateway.values.set(32, VALUE);
		});

		after(() => stopAdapter(harness));

		it("fails when the gateway does not answer", async function () {
			this.timeout(40000);
			await prepare(harness, TWO_GATEWAYS);
			gateway.silent.add("gatt:read");

			const started = Date.now();
			const response = await read(harness);

			expect(response.error.code).to.equal("TIMEOUT");
			expect(Date.now() - started).to.be.within(9000, 20000);
			await waitFor(
				() =>
					gateway.commands.some(
						(c) => c.command === "gatt:disconnect",
					),
				"gatt:disconnect",
			);
		});

		it("fails pending requests when the connection is lost", async function () {
			this.timeout(40000);
			await prepare(harness, TWO_GATEWAYS);
			gateway.silent.add("gatt:read");

			const pending = read(harness);
			await waitFor(
				() => gateway.commands.some((c) => c.command === "gatt:read"),
				"gatt:read to arrive",
			);
			await new Promise((resolve) => setTimeout(resolve, 500));
			const reported = Date.now();
			gateway.open.delete(`proxy-og|${DEVICE}`);
			getMessageClient(harness).push("system.adapter.ble2.0", {
				command: "gateway:connectionState",
				message: {
					gatewayId: "proxy-og",
					address: DEVICE,
					connected: false,
				},
				from: "system.adapter.test.0",
			});

			const response = await pending;
			expect(response.error.code).to.equal("NOT_CONNECTED");
			expect(Date.now() - reported).to.be.below(3000);
		});

		it("can connect again afterwards", async function () {
			this.timeout(30000);
			await prepare(harness, TWO_GATEWAYS);

			const response = await read(harness);

			expect(response).to.deep.equal({
				error: null,
				result: { data: Buffer.from(VALUE, "hex").toString("base64") },
			});
		});
	});
};
