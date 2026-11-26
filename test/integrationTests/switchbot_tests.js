// @ts-check

const { expect } = require("chai");
const { FakeGattGateway } = require("./fakeGattGateway");
const {
	deliver,
	PACKETS,
	sendToAdapter,
	startAdapter,
	stopAdapter,
	waitFor,
} = require("./helpers");

const bot = "aa:bb:cc:11:22:33";
const gatewayId = "bot";

class BotGateway extends FakeGattGateway {
	handle(command, message) {
		if (command !== "gatt:getServices") {
			return super.handle(command, message);
		}
		return {
			error: null,
			result: {
				services: [
					{
						uuid: "cba20d00-224d-11e6-9fb8-0002a5d5c51b",
						handle: 50,
						characteristics: [
							{
								uuid: "cba20002-224d-11e6-9fb8-0002a5d5c51b",
								handle: 52,
								properties: 8,
								descriptors: [],
							},
							{
								uuid: "cba20003-224d-11e6-9fb8-0002a5d5c51b",
								handle: 54,
								properties: 16,
								descriptors: [],
							},
						],
					},
				],
			},
		};
	}
}

exports.runTests = function (suite) {
	suite("SwitchBot Bot actions", (getHarness) => {
		let harness;
		before(async function () {
			this.timeout(60000);
			harness = getHarness();
			await startAdapter(harness);
		});
		after(() => stopAdapter(harness));

		it("confirms actions via the vendor notification and reports a device rejection", async function () {
			this.timeout(30000);
			const gateway = new BotGateway(harness);
			gateway.setWriteHandler((_address, handle, data) => {
				expect(handle).to.equal(52);
				const response = data === "570102" ? "06" : "01ff00";
				// Write requests and response notifications use different characteristics.
				void sendToAdapter(harness, "gateway:notification", {
					gatewayId,
					address: bot,
					handle: 54,
					data: Buffer.from(response, "hex").toString("base64"),
				});
				return undefined;
			});
			expect(
				await sendToAdapter(harness, "gateway:announce", {
					protocol: "ble-gateway/1",
					gateways: [{ gatewayId, connect: true, freeSlots: 1 }],
				}),
			).to.have.property("error", null);
			await deliver(harness, gatewayId, [
				{
					address: bot,
					addressType: "random",
					data: PACKETS.bthomeThermometer,
				},
			]);

			expect(
				(
					await sendToAdapter(harness, "switchBot", {
						address: bot,
						action: "invalid",
					})
				).error.code,
			).to.equal("INVALID_PAYLOAD");
			expect(gateway.commands).to.be.empty;
			for (const action of ["press", "on", "stop"]) {
				expect(
					await sendToAdapter(harness, "switchBot", {
						address: bot,
						action,
					}),
				).to.deep.equal({ error: null, result: {} });
			}
			expect(
				(
					await sendToAdapter(harness, "switchBot", {
						address: bot,
						action: "off",
					})
				).error,
			).to.include({
				code: "GATT_ERROR",
				message: "SwitchBot rejected the action (status 0x06)",
			});

			await waitFor(
				() => gateway.open.size === 0,
				"the Bot session to disconnect",
			);
			const commands = gateway.commands
				.filter(({ command }) => command === "gatt:write")
				.map(({ message }) =>
					Buffer.from(message.data, "base64").toString("hex"),
				);
			expect(commands).to.deep.equal([
				"570100",
				"570101",
				"570103",
				"570102",
			]);
		});
	});
};
