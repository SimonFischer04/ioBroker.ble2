// @ts-check

const { expect } = require("chai");
const { FakeGattGateway } = require("./fakeGattGateway");
const {
	buildAdvertisement,
	deliver,
	sendToAdapter,
	startAdapter,
	stopAdapter,
} = require("./helpers");

const address = "aa:bb:cc:11:22:33";
const status = "0f55000000000414561051000004f91b001d70d8";

class ChargerGateway extends FakeGattGateway {
	handle(command, message) {
		if (command === "gatt:getServices") {
			return {
				error: null,
				result: {
					services: [
						{
							uuid: "0000ffe0-0000-1000-8000-00805f9b34fb",
							handle: 28,
							characteristics: [
								{
									uuid: "0000ffe1-0000-1000-8000-00805f9b34fb",
									handle: 30,
									properties: 0x14,
									descriptors: [],
								},
							],
						},
					],
				},
			};
		}
		return super.handle(command, message);
	}
}

exports.runTests = function (suite) {
	suite("SkyRC MC3000 charging slot", (getHarness) => {
		let harness;
		before(async function () {
			this.timeout(60000);
			harness = getHarness();
			await startAdapter(harness);
		});
		after(() => stopAdapter(harness));

		it("subscribes before querying and ignores unrelated or corrupt status frames", async function () {
			this.timeout(20000);
			const gateway = new ChargerGateway(harness);
			gateway.setWriteHandler(() => [
				// The first frame is for slot 2. The second has an invalid checksum.
				`0f5501${status.slice(6, -2)}d9`,
				`${status.slice(0, -2)}00`,
				status,
			]);
			await sendToAdapter(harness, "gateway:announce", {
				protocol: "ble-gateway/1",
				gateways: [{ gatewayId: "charger", connect: true }],
			});
			await deliver(harness, "charger", [
				{
					address,
					data: buildAdvertisement([0x03, "e0ff"]),
				},
			]);

			const readSlot = (slot) =>
				sendToAdapter(harness, "readSkyrcMc3000Slot", {
					address,
					slot,
				});
			expect((await readSlot(0)).error.code).to.equal("INVALID_PAYLOAD");
			expect(gateway.commands).to.have.length(0);

			expect(await readSlot(1)).to.deep.equal({
				error: null,
				result: {
					slot: 1,
					status: 4,
					elapsedSeconds: 5206,
					voltage: 4.177,
					current: 0,
					capacity: 1273,
					temperature: 27,
				},
			});
			expect(
				gateway.commands.map(({ command }) => command),
			).to.deep.equal([
				"gatt:connect",
				"gatt:subscribe",
				"gatt:write",
				"gatt:disconnect",
			]);
			const write = gateway.commands.find(
				({ command }) => command === "gatt:write",
			);
			expect(write.message).to.include({
				handle: 30,
				withResponse: false,
			});
			expect(
				Buffer.from(write.message.data, "base64").toString("hex"),
			).to.equal("0f55000000000000000000000000000000000064");
		});

		it("disconnects and reports a timeout when no slot status arrives", async function () {
			this.timeout(20000);
			const gateway = new ChargerGateway(harness);
			const { error } = await sendToAdapter(
				harness,
				"readSkyrcMc3000Slot",
				{
					address,
					slot: 4,
				},
			);
			expect(error).to.deep.equal({
				code: "TIMEOUT",
				message: "No MC3000 slot status received",
			});
			expect(gateway.open.size).to.equal(0);
			expect(gateway.commands.at(-1).command).to.equal("gatt:disconnect");
		});
	});
};
