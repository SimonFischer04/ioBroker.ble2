import type BTHomeModule = require("./bthome");
import { expect } from "chai";
import * as proxyquireModule from "proxyquire";
import { createGlobalMock } from "../../test/mocks/global";
import type {} from "../lib/adapter-config";
import type { PeripheralInfo } from "../lib/scanProcessInterface";

const globalMock = createGlobalMock({});
const plugin = proxyquireModule.noPreserveCache()<typeof BTHomeModule>(
	"./bthome",
	{ "../lib/global": globalMock },
);

describe("BTHome plugin measurements", () => {
	it("creates matching objects and values for the added sensor types", () => {
		const peripheral = {
			advertisement: {
				serviceData: [
					{
						uuid: "fcd2",
						data: Buffer.from(
							"4055e803000059ff5afeff5bfdffffff5c02fbffff5e1027",
							"hex",
						),
					},
				],
			},
		} as PeripheralInfo;
		expect(plugin.isHandling(peripheral)).to.be.true;
		const context = plugin.createContext(peripheral)!;
		expect(context).to.exist;
		const objects = plugin.defineObjects(context)!;
		const values = plugin.getValues(context)!;
		expect(values).to.include({
			volume_storage: 1,
			count: -1,
			count_2: -2,
			count_3: -3,
			direction: 100,
		});
		expect(values.power).to.be.closeTo(-12.78, 0.000001);
		expect(objects.states.map((s) => s.id)).to.deep.equal(
			Object.keys(values),
		);
		expect(
			objects.states.find((s) => s.id === "volume_storage")!.common!.unit,
		).to.equal("L");
		expect(
			objects.states.find((s) => s.id === "power")!.common!.unit,
		).to.equal("W");
		expect(
			objects.states.find((s) => s.id === "direction")!.common!.unit,
		).to.equal("°");
	});
});

describe("Encrypted BTHome advertisements", () => {
	// Published test vector: https://bthome.io/encryption/
	const mac = "54:48:e6:8f:80:a5";
	const key = "231d39c1-d7cc-1ab1-aee2-24cd096db932";
	const encrypted = "41e445f3c9962b332211006c7c4519";
	const button = "45b91c342211000bc21df1";
	const newer = "415121e2839ee835221100cc3739bc";
	const clear = "4002ca0903bf13";

	function configure(bindkey?: string): void {
		globalMock.Global.adapter.config.bthomeBindkeys = bindkey
			? JSON.stringify([{ address: mac.toUpperCase(), key: bindkey }])
			: undefined;
		plugin.initialize!();
	}

	function processFrame(
		hex: string,
		address = mac,
	): ReturnType<typeof plugin.getValues> {
		const peripheral = {
			address,
			advertisement: {
				serviceData: [{ uuid: "fcd2", data: Buffer.from(hex, "hex") }],
			},
		} as PeripheralInfo;
		return plugin.getValues(plugin.createContext(peripheral));
	}

	beforeEach(() => configure(key));
	after(() => configure());

	it("authenticates the specification vector and decodes measurements", () => {
		const values = processFrame(encrypted);
		expect(values?.temperature).to.be.closeTo(25.06, 0.000001);
		expect(values?.humidity).to.be.closeTo(50.55, 0.000001);
	});

	it("decodes a trigger-based button event and rejects repeated and older counters", () => {
		expect(processFrame(button)).to.deep.equal({ button: "press" });
		expect(processFrame(button)).to.be.undefined;
		expect(processFrame(encrypted)).to.be.undefined;
		expect(processFrame(newer)?.temperature).to.be.closeTo(25.07, 0.000001);
	});

	it("ignores corrupt or truncated frames without advancing the counter", () => {
		expect(processFrame(`${newer.slice(0, -2)}00`)).to.be.undefined;
		expect(processFrame(encrypted.slice(0, 16))).to.be.undefined;
		expect(processFrame(encrypted)).to.exist;
	});

	it("requires a matching key and keeps plaintext support for unconfigured devices", () => {
		expect(processFrame(clear)).to.be.undefined;
		expect(processFrame(encrypted, "54:48:e6:8f:80:a6")).to.be.undefined;
		configure("00".repeat(16));
		expect(processFrame(encrypted)).to.be.undefined;
		configure();
		expect(processFrame(encrypted)).to.be.undefined;
		expect(processFrame(clear)?.temperature).to.be.closeTo(25.06, 0.000001);
	});
});
