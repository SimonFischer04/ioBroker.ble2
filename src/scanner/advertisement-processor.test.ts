import { expect } from "chai";
import { DeviceRegistry } from "../devices/device-registry";
import type { GatewayRegistry } from "../gateways/gateway-registry";
import type { PeripheralInfo } from "../lib/advertisement";
import { Global } from "../lib/global";
import type { ObjectCache } from "../lib/object-cache";
import type { Plugin } from "../plugins/plugin";
import { AdvertisementProcessor } from "./advertisement-processor";

describe("AdvertisementProcessor discovery allowlist", () => {
	let previousAdapter: ioBroker.Adapter;
	let previousCache: ObjectCache;
	let known: Set<string>;
	let handled: string[];
	let processor: AdvertisementProcessor;

	beforeEach(() => {
		previousAdapter = Global.adapter;
		previousCache = Global.objectCache;
		known = new Set();
		handled = [];
		Global.adapter = {
			namespace: "ble2.0",
			log: { level: "info", info: () => {}, warn: () => {} },
			setTimeout: () => 1,
			clearTimeout: () => {},
		} as unknown as ioBroker.Adapter;
		Global.objectCache = {
			objectExists: (id: string) => Promise.resolve(known.has(id)),
		} as ObjectCache;
	});

	afterEach(() => {
		processor?.dispose();
		Global.adapter = previousAdapter;
		Global.objectCache = previousCache;
	});

	function start(discoveryAllowlist?: string): void {
		processor = new AdvertisementProcessor(
			{
				plugins: [
					{
						isHandling: (p: PeripheralInfo) => {
							handled.push(p.address);
							return false;
						},
					} as Plugin,
				],
				allowEmptyDevices: false,
				discoveryAllowlist,
				rssiUpdateInterval: 0,
				rssiTimeoutSeconds: 0,
			},
			new DeviceRegistry(),
			{} as GatewayRegistry,
		);
		processor.setAllowNewDevices(true);
	}

	async function send(address: string): Promise<void> {
		await processor.process({
			id: address.replace(/:/g, ""),
			uuid: address.replace(/:/g, ""),
			address,
			addressType: "public",
			advertisement: { manufacturerData: Buffer.from([1, 2]) },
			rssi: -60,
		});
	}

	it("admits matching addresses and keeps known excluded devices updating", async () => {
		start("AA-BB-CC-DD-EE-01, aabbccddee02\ninvalid");
		await send("aa:bb:cc:dd:ee:01");
		await send("aa:bb:cc:dd:ee:02");
		await send("aa:bb:cc:dd:ee:03");
		expect(handled).to.deep.equal([
			"aa:bb:cc:dd:ee:01",
			"aa:bb:cc:dd:ee:02",
		]);

		const id = "ble2.0.aa:bb:cc:dd:ee:03.rssi";
		known.add(id);
		processor.observeObject(id);
		await send("aa:bb:cc:dd:ee:03");
		expect(handled).to.include("aa:bb:cc:dd:ee:03");
	});

	it("allows all with an empty list and rejects new devices with an invalid list", async () => {
		start("  ");
		await send("aa:bb:cc:dd:ee:01");
		expect(handled).to.deep.equal(["aa:bb:cc:dd:ee:01"]);
		processor.dispose();
		handled = [];
		start("invalid");
		await send("aa:bb:cc:dd:ee:02");
		expect(handled).to.be.empty;
	});
});
