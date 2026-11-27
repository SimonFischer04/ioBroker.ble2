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

class CandelaGateway extends FakeGattGateway {
	handle(command, message) {
		if (command === "gatt:getServices") {
			return {
				error: null,
				result: {
					services: [
						{
							uuid: "12345678-1234-abcd-1234-123456789abc",
							handle: 25,
							characteristics: [
								{
									uuid: "12345679-1234-abcd-1234-123456789abc",
									handle: 31,
									properties: 8,
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
	suite("Yeelight Candela brightness", (getHarness) => {
		let harness;
		before(async function () {
			this.timeout(60000);
			harness = getHarness();
			await startAdapter(harness, { plugins: "yeelight" });
		});
		after(() => stopAdapter(harness));

		it("validates the lamp and sends the power and brightness writes", async function () {
			this.timeout(20000);
			const gateway = new CandelaGateway(harness);
			await sendToAdapter(harness, "gateway:announce", {
				protocol: "ble-gateway/1",
				gateways: [{ gatewayId: "candela", connect: true }],
			});
			const call = (brightness) =>
				sendToAdapter(harness, "setCandelaBrightness", {
					address,
					brightness,
				});

			expect((await call(101)).error.code).to.equal("INVALID_PAYLOAD");
			expect((await call(70)).error.code).to.equal("GATT_ERROR");
			expect(gateway.commands).to.have.length(0);

			await deliver(harness, "candela", [
				{
					address,
					data: buildAdvertisement([
						0x09,
						Buffer.from("yeelight_ms").toString("hex"),
					]),
				},
			]);
			const bright = await call(70);
			expect(bright).to.deep.equal({
				error: null,
				result: { brightness: 70 },
			});
			const off = await call(0);
			expect(off).to.deep.equal({
				error: null,
				result: { brightness: 0 },
			});
			const writes = gateway.commands.filter(
				({ command }) => command === "gatt:write",
			);
			for (const { message } of writes) {
				expect(message).to.include({ handle: 31, withResponse: true });
			}
			expect(
				writes.map(({ message }) =>
					Buffer.from(message.data, "base64").toString("hex"),
				),
			).to.deep.equal(["434001", "434246", "434002"]);
		});
	});
};
