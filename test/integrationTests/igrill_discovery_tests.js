// @ts-check

const { expect } = require("chai");
const {
	NAMESPACE,
	allowNewDevices,
	deliver,
	startAdapter,
	stopAdapter,
	waitFor,
	waitForValue,
} = require("./helpers");

exports.runTests = function (suite) {
	suite("Weber iGrill mini discovery", (getHarness) => {
		let harness;
		before(async function () {
			this.timeout(60000);
			harness = getHarness();
			await startAdapter(harness, {
				plugins: "igrill",
				allowEmptyDevices: true,
			});
		});
		after(() => stopAdapter(harness));

		it("records the original service UUID advertisement as an iGrill mini", async function () {
			this.timeout(20000);
			const address = "aa:bb:cc:11:22:33";
			// Actual scan capture attached to upstream issue AlCalzone/ioBroker.ble#165.
			const scan = Buffer.from(
				"0201060c08694772696c6c5f6d696e69110761784732cf92ff956142824a0000c763",
				"hex",
			);
			await allowNewDevices(harness);
			await deliver(harness, "igrill", [
				{
					address,
					rssi: -57,
					data: scan.toString("base64"),
				},
			]);
			await waitForValue(harness, `${address}.rssi`, -57);
			const object = await waitFor(
				() => harness.objects.getObjectAsync(`${NAMESPACE}.${address}`),
				"iGrill device object",
			);
			expect(object.common.name).to.equal("Weber iGrill mini");
		});
	});
};
