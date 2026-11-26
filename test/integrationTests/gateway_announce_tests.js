// @ts-check

/**
 * Gateway Interface Integration Test - announcing gateways
 *
 * Gateways that can open connections to devices announce themselves with "gateway:announce", with
 * their free connection slots. The answer tells the protocol and when the adapter was started, so
 * the delivering instance notices a restart. An announcement keeps a gateway online like delivered
 * advertisements do (the timeout is 2 seconds in this suite).
 */

const { expect } = require("chai");
const {
	SENDER,
	delay,
	deliver,
	getValue,
	sendToAdapter,
	startAdapter,
	stopAdapter,
	waitFor,
	waitForValue,
	PACKETS,
} = require("./helpers");

/** @import { IntegrationTestHarness } from "@iobroker/testing" */
/** @import { GatewayAnnouncement, GatewayInfo } from "../../src/lib/gateway-protocol" */

const OG = "gateways.test_0_proxy-og";

/**
 * Announces gateways like a delivering instance does
 *
 * @param {IntegrationTestHarness} harness - Integration test harness
 * @param {GatewayAnnouncement[]} gateways - The gateways
 * @param {string} [protocol] - The protocol
 * @returns {Promise<ioBroker.MessagePayload>} The answer of the adapter
 */
function announce(harness, gateways, protocol = "ble-gateway/1") {
	return sendToAdapter(harness, "gateway:announce", { protocol, gateways });
}

/**
 * Reads the gateways from the adapter, by ID
 *
 * @param {IntegrationTestHarness} harness - Integration test harness
 * @returns {Promise<Record<string, GatewayInfo>>} The gateways the adapter lists
 */
async function getGateways(harness) {
	const response = await sendToAdapter(harness, "getGateways", {});
	return Object.fromEntries(response.result.map((g) => [g.id, g]));
}

/**
 * Defines the suites of this file
 *
 * @param {(name: string, fn: (getHarness: () => IntegrationTestHarness) => void) => void} suite - Defines a suite with a fresh harness
 */
exports.runTests = function (suite) {
	suite("Gateway interface - announcing gateways", (getHarness) => {
		let harness;
		let epoch;

		before(async function () {
			this.timeout(60000);
			harness = getHarness();
			await startAdapter(harness, {
				plugins: "bthome",
				gatewayTimeout: 2,
			});
		});

		after(() => stopAdapter(harness));

		it("answers with the protocol and the start time", async function () {
			this.timeout(30000);

			const response = await announce(harness, []);
			expect(response.error).to.be.null;
			expect(response.result.protocol).to.equal("ble-gateway/1");
			epoch = response.result.epoch;
			expect(epoch)
				.to.be.a("number")
				.within(Date.now() - 60000, Date.now());

			const again = await announce(harness, []);
			expect(again).to.deep.equal({
				error: null,
				result: { protocol: "ble-gateway/1", epoch },
			});
		});

		it("lists an announced gateway with what it can do", async function () {
			this.timeout(30000);

			await announce(harness, [
				{
					gatewayId: "proxy-og",
					connect: true,
					freeSlots: 3,
					slotLimit: 3,
				},
			]);

			const gateways = await getGateways(harness);
			expect(gateways[`${SENDER}:proxy-og`]).to.include({
				type: "remote",
				sender: SENDER,
				connected: true,
				connect: true,
				freeSlots: 3,
				slotLimit: 3,
			});
			await waitForValue(harness, `${OG}.connected`, true);
			await waitForValue(harness, `${OG}.freeSlots`, 3);
			const obj = await harness.objects.getObjectAsync(
				`ble2.0.${OG}.freeSlots`,
			);
			expect(obj.common).to.include({
				type: "number",
				role: "value",
				write: false,
			});
		});

		it("updates the free slots", async function () {
			this.timeout(30000);

			await announce(harness, [
				{
					gatewayId: "proxy-og",
					connect: true,
					freeSlots: 2,
					slotLimit: 3,
				},
			]);
			await waitForValue(harness, `${OG}.freeSlots`, 2);
			expect(
				(await getGateways(harness))[`${SENDER}:proxy-og`].freeSlots,
			).to.equal(2);
		});

		it("keeps a gateway online that only announces itself", async function () {
			this.timeout(30000);

			for (let i = 0; i < 6; i++) {
				await announce(harness, [
					{
						gatewayId: "proxy-og",
						connect: true,
						freeSlots: 2,
						slotLimit: 3,
					},
				]);
				await delay(500);
			}
			expect(await getValue(harness, `${OG}.connected`)).to.equal(true);
		});

		it("marks an announced gateway offline when it goes silent", async function () {
			this.timeout(30000);

			await waitForValue(harness, `${OG}.connected`, false, 8000);
		});

		it("rejects an unknown protocol", async function () {
			this.timeout(30000);

			const response = await announce(
				harness,
				[{ gatewayId: "proxy-v2", connect: true }],
				"ble-gateway/2",
			);
			expect(response.error.code).to.equal("UNSUPPORTED_PROTOCOL");
			expect(await getGateways(harness)).to.not.have.property(
				`${SENDER}:proxy-v2`,
			);
		});

		it("rejects invalid announcements", async function () {
			this.timeout(30000);

			for (const message of [
				"announce",
				{ protocol: "ble-gateway/1" },
				{
					protocol: "ble-gateway/1",
					gateways: [{ gatewayId: "p", connect: 1 }],
				},
			]) {
				const response = await sendToAdapter(
					harness,
					"gateway:announce",
					message,
				);
				expect(response.error.code, JSON.stringify(message)).to.equal(
					"INVALID_PAYLOAD",
				);
			}
		});

		it("lists a gateway that only delivers advertisements as not able to connect", async function () {
			this.timeout(30000);

			await deliver(harness, "proxy-passive", [
				{
					address: "a4:c1:38:12:34:56",
					data: PACKETS.bthomeThermometer,
				},
			]);
			const gateway = await waitFor(
				async () =>
					(await getGateways(harness))[`${SENDER}:proxy-passive`],
				"the gateway to be listed",
			);
			expect(gateway).to.include({ connected: true, connect: false });
			expect(gateway).to.not.have.property("freeSlots");
		});
	});
};
