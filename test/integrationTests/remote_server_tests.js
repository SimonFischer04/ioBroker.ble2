// @ts-check

/**
 * Remote Scan Server Integration Test
 *
 * bin/blerp.js runs the scanner on another host and serves the advertisements via TCP. The adapter
 * connects to every server in the setting remoteServers, each one is a gateway of its own and works
 * alongside the other sources: the same packet from two servers is decoded once. The servers are
 * played by FakeScanServer, which speaks the protocol of blerp.js without Bluetooth.
 *
 * Up to 0.14 there was a single server (setting "server"), which disabled the local Bluetooth adapter.
 * The second suite checks that such a configuration is migrated without changing its behaviour.
 */

const { expect } = require("chai");
const { FakeScanServer } = require("./fakeScanServer");
const {
	NAMESPACE,
	allowNewDevices,
	delay,
	getChildProcesses,
	getValue,
	sendToAdapter,
	startAdapter,
	stopAdapter,
	waitFor,
	waitForValue,
} = require("./helpers");

const DEVICE = "a4:c1:38:12:34:56";
/** BTHome v2: battery 100 %, 25.00 °C, 50.55 % */
const BTHOME = "4000a5016402c40903bf13";
/** The same thermometer a measurement later: 25.50 °C */
const BTHOME_NEXT = "4000a6016402f609032413";

/**
 * @param {FakeScanServer} server - The fake server
 * @returns {string} ID of its gateway
 */
function gatewayId(server) {
	return `server:127.0.0.1:${server.port}`;
}

/**
 * @param {FakeScanServer} server - The fake server
 * @returns {string} ID of the channel with the states of its gateway
 */
function gatewayStates(server) {
	return `gateways.server_127_0_0_1_${server.port}`;
}

/**
 * Reads the gateways from the adapter, by ID
 *
 * @param {any} harness - Integration test harness
 * @returns {Promise<Record<string, any>>}
 */
async function getGateways(harness) {
	const response = await sendToAdapter(harness, "getGateways", {});
	return Object.fromEntries(
		response.result.map((/** @type {any} */ g) => [g.id, g]),
	);
}

/** @param {(name: string, fn: (getHarness: () => any) => void) => void} suite */
exports.runTests = function (suite) {
	suite("Remote scan servers - several at once", (getHarness) => {
		/** @type {any} */
		let harness;
		const keller = new FakeScanServer();
		const og = new FakeScanServer();

		before(async function () {
			this.timeout(60000);
			harness = getHarness();
			await keller.start();
			await og.start();
			await startAdapter(harness, {
				plugins: "bthome",
				remoteServers: `127.0.0.1:${keller.port}, 127.0.0.1:${og.port}\nnot:a:server`,
			});
			await allowNewDevices(harness);
		});

		after(async () => {
			await stopAdapter(harness);
			await keller.stop();
			await og.stop();
		});

		it("connects to every server and lists it as a gateway", async function () {
			this.timeout(30000);

			await waitFor(
				() => keller.connected && og.connected,
				"both servers to be connected",
			);
			const gateways = await waitFor(async () => {
				const result = await getGateways(harness);
				return result[gatewayId(keller)]?.connected &&
					result[gatewayId(og)]?.connected
					? result
					: undefined;
			}, "both gateways to be listed as connected");
			expect(gateways[gatewayId(keller)]).to.include({ type: "server" });

			await waitForValue(
				harness,
				`${gatewayStates(keller)}.connected`,
				true,
			);
			await waitForValue(harness, `${gatewayStates(og)}.connected`, true);
			await waitForValue(harness, "info.connection", true);
		});

		it("ignores an invalid entry and keeps running", async function () {
			this.timeout(30000);

			expect(harness.isAdapterRunning(), "adapter is running").to.be.true;
			const gateways = await getGateways(harness);
			expect(Object.keys(gateways).sort()).to.deep.equal(
				[gatewayId(keller), gatewayId(og)].sort(),
			);
		});

		it("decodes what a server receives", async function () {
			this.timeout(30000);

			keller.discover(DEVICE, "fcd2", BTHOME, -80);
			await waitForValue(harness, `${DEVICE}.temperature`, 25);
			await waitForValue(harness, `${DEVICE}.rssi`, -80);
		});

		it("decodes a packet once when two servers receive it", async function () {
			this.timeout(30000);

			keller.discover(DEVICE, "fcd2", BTHOME_NEXT, -80);
			og.discover(DEVICE, "fcd2", BTHOME_NEXT, -55);

			await waitForValue(harness, `${DEVICE}.temperature`, 25.5);
			const gateways = await waitFor(async () => {
				const result = await getGateways(harness);
				return result[gatewayId(og)]?.duplicates === 1
					? result
					: undefined;
			}, "the second copy to be counted as duplicate");
			expect(gateways[gatewayId(keller)]).to.include({
				advertisements: 2,
				duplicates: 0,
			});
			expect(gateways[gatewayId(og)]).to.include({
				advertisements: 1,
				duplicates: 1,
			});

			const devices = await sendToAdapter(harness, "getDevices", {});
			const device = devices.result.find(
				(/** @type {any} */ d) => d.address === DEVICE,
			);
			expect(
				device.gateways.map((/** @type {any} */ g) => g.id),
			).to.deep.equal([gatewayId(og), gatewayId(keller)]);
		});

		it("only handles advertisements of the monitored services", async function () {
			this.timeout(30000);
			const other = "a4:c1:38:00:00:02";
			const marker = "a4:c1:38:00:00:03";

			// Only the service of the BTHome plugin (fcd2) is monitored
			keller.discover(other, "181a", "a4c13812345600c4");
			keller.discover(marker, "fcd2", BTHOME);

			await waitForValue(harness, `${marker}.temperature`, 25);
			await delay(300);
			expect(
				await harness.objects.getObjectAsync(`${NAMESPACE}.${other}`),
			).to.not.be.ok;
		});

		it("does not write info.driverState with several servers", async function () {
			this.timeout(30000);

			// Every server reported "poweredOn", but with several sources the state would be meaningless
			expect(await getValue(harness, "info.driverState")).to.not.equal(
				"poweredOn",
			);
		});

		it("takes a server offline when it stops, the others stay", async function () {
			this.timeout(30000);

			await keller.stop();

			await waitForValue(
				harness,
				`${gatewayStates(keller)}.connected`,
				false,
				5000,
			);
			expect(
				await getValue(harness, `${gatewayStates(og)}.connected`),
			).to.equal(true);
			expect(await getValue(harness, "info.connection")).to.equal(true);
		});

		it("connects again when the server is back", async function () {
			this.timeout(40000);
			const before = keller.connections;
			const received = (await getGateways(harness))[gatewayId(keller)]
				.advertisements;

			await keller.start();

			// The adapter tries again every 10 seconds
			await waitFor(
				() => keller.connections > before,
				"the adapter to connect again",
				25000,
			);
			await waitForValue(
				harness,
				`${gatewayStates(keller)}.connected`,
				true,
			);
			keller.discover(DEVICE, "fcd2", BTHOME, -60);
			await waitFor(async () => {
				const gateways = await getGateways(harness);
				return (
					gateways[gatewayId(keller)].advertisements === received + 1
				);
			}, "the advertisement of the reconnected server");
		});
	});

	suite(
		"Remote scan servers - migration of the setting of version 0.14",
		(getHarness) => {
			/** @type {any} */
			let harness;
			const server = new FakeScanServer();

			before(async function () {
				this.timeout(60000);
				harness = getHarness();
				await server.start();
				// As an instance of 0.14 looks after the upgrade: the old setting, and the new ones with their defaults
				await startAdapter(harness, {
					plugins: "bthome",
					server: `127.0.0.1:${server.port}`,
					remoteServers: "",
					localScanner: true,
				});
			});

			after(async () => {
				await stopAdapter(harness);
				await server.stop();
			});

			it("moves the server to the new setting and keeps the local Bluetooth adapter off", async function () {
				this.timeout(30000);

				const instance = await waitFor(async () => {
					const obj = await harness.objects.getObjectAsync(
						`system.adapter.${NAMESPACE}`,
					);
					return obj && obj.native.remoteServers ? obj : undefined;
				}, "the migrated settings");
				expect(instance.native).to.include({
					server: "",
					remoteServers: `127.0.0.1:${server.port}`,
					localScanner: false,
				});
			});

			it("uses the server, like before", async function () {
				this.timeout(30000);

				await waitFor(
					() => server.connected,
					"the server to be connected",
				);
				await waitForValue(
					harness,
					`${gatewayStates(server)}.connected`,
					true,
				);
				// The only source reports the state of its Bluetooth driver, as up to 0.14
				await waitForValue(harness, "info.driverState", "poweredOn");
			});

			it("does not start the scanner of the local Bluetooth adapter", async function () {
				this.timeout(30000);

				const children = getChildProcesses(harness.adapterProcess.pid);
				if (children === undefined) {
					// Cannot be determined on this platform
					this.skip();
				}
				expect(
					children,
					"child processes of the adapter",
				).to.deep.equal([]);
			});
		},
	);
};
