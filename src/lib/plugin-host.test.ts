import { expect } from "chai";
import type { ConnectionManager } from "../connections/connection-manager";
import type { DeviceRegistry } from "../devices/device-registry";
import {
	NO_DECODER,
	type Plugin,
	type PluginInstance,
} from "../plugins/plugin";
import type { PeripheralInfo } from "./advertisement";
import { GatewayError } from "./gateway-error";
import { PluginHost } from "./plugin-host";

describe("lib/plugin-host => PluginHost", () => {
	let logs: string[];
	let host: PluginHost;
	const ctx = {
		adapter: { namespace: "ble2.0" } as unknown as ioBroker.Adapter,
		connections: {} as ConnectionManager,
		devices: {} as DeviceRegistry,
	};
	const state = (val: ioBroker.StateValue, ack = false): ioBroker.State =>
		({ val, ack }) as ioBroker.State;

	/**
	 * A plugin with only an active part
	 *
	 * @param name Name of the plugin
	 * @param start Its active part
	 */
	function plugin(name: string, start?: Plugin["start"]): Plugin<undefined> {
		return { name, description: name, ...NO_DECODER, start };
	}

	beforeEach(() => {
		logs = [];
		host = new PluginHost({
			info: (m: string) => logs.push(`info ${m}`),
			warn: (m: string) => logs.push(`warn ${m}`),
			error: (m: string) => logs.push(`error ${m}`),
		});
	});

	it("starts the active parts and skips plugins without one", async () => {
		const started: string[] = [];
		await host.start(
			[
				plugin("a", () => {
					started.push("a");
					return {};
				}),
				plugin("b"),
				plugin("c", () => {
					started.push("c");
					return Promise.resolve({});
				}),
			],
			ctx,
		);
		expect(started).to.deep.equal(["a", "c"]);
	});

	it("reports a plugin that fails to start and starts the others", async () => {
		const started: string[] = [];
		await host.start(
			[
				plugin("broken", () => {
					throw new Error("no");
				}),
				plugin("fine", () => {
					started.push("fine");
					return {};
				}),
			],
			ctx,
		);
		expect(started).to.deep.equal(["fine"]);
		expect(logs).to.deep.equal(["error Plugin broken could not start: no"]);
	});

	it("runs the commands of the plugins and turns errors into answers", async () => {
		await host.start(
			[
				plugin("p", () => ({
					commands: {
						ok: (message) => Promise.resolve({ echo: message }),
						fails: () =>
							Promise.reject(
								new GatewayError("NOT_CONNECTED", "gone"),
							),
					},
				})),
			],
			ctx,
		);
		expect(host.hasCommand("ok")).to.equal(true);
		expect(host.hasCommand("other")).to.equal(false);
		expect(await host.runCommand("ok", 1)).to.deep.equal({
			error: null,
			result: { echo: 1 },
		});
		expect(await host.runCommand("fails", {})).to.deep.equal({
			error: { code: "NOT_CONNECTED", message: "gone" },
		});
	});

	it("does not let a plugin take over a command of the core or of another plugin", async () => {
		const handler = (): Promise<string> => Promise.resolve("x");
		await host.start(
			[
				plugin("first", () => ({ commands: { shared: handler } })),
				plugin("second", () => ({
					commands: {
						shared: () => Promise.resolve("y"),
						getDevices: handler,
					},
				})),
			],
			ctx,
			["getDevices"],
		);
		expect(host.hasCommand("getDevices")).to.equal(false);
		expect(await host.runCommand("shared", undefined)).to.deep.equal({
			error: null,
			result: "x",
		});
		expect(logs).to.have.lengthOf(2);
	});

	it("hands advertisements to every plugin, a failing one does not stop the others", async () => {
		const seen: string[] = [];
		await host.start(
			[
				plugin("broken", () => ({
					observe: () => {
						throw new Error("bad");
					},
				})),
				plugin("fine", () => ({
					observe: (p) => seen.push(p.address),
				})),
			],
			ctx,
		);
		host.observe({ address: "a4:c1:38:12:34:56" } as PeripheralInfo);
		expect(seen).to.deep.equal(["a4:c1:38:12:34:56"]);
		expect(logs[0]).to.match(/^warn Plugin broken failed/);
	});

	it("passes a state change to the plugins until one takes it", async () => {
		const asked: string[] = [];
		const instance = (name: string, takes: boolean): PluginInstance => ({
			handleStateChange: () => {
				asked.push(name);
				return takes;
			},
		});
		await host.start(
			[
				plugin("a", () => instance("a", false)),
				plugin("b", () => instance("b", true)),
				plugin("c", () => instance("c", true)),
			],
			ctx,
		);
		expect(host.handleStateChange("ble2.0.x", state(true))).to.equal(true);
		expect(asked).to.deep.equal(["a", "b"]);
	});

	it("passes on button presses that arrive while the plugins start", async () => {
		const handled: string[] = [];
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const starting = host.start(
			[
				plugin("slow", async () => {
					await gate;
					return {
						handleStateChange: (id) => {
							handled.push(id);
							return true;
						},
					};
				}),
			],
			ctx,
		);

		// Own state, not acknowledged: held
		expect(
			host.handleStateChange("ble2.0.dev.button", state(true)),
		).to.equal(false);
		// Foreign or acknowledged states are not held
		host.handleStateChange("system.adapter.esphome.0.alive", state(false));
		host.handleStateChange("ble2.0.dev.value", state(1, true));
		expect(handled).to.deep.equal([]);

		release();
		await starting;
		expect(handled).to.deep.equal(["ble2.0.dev.button"]);
	});

	it("stops the plugins and forgets their commands", async () => {
		const stopped: string[] = [];
		await host.start(
			[
				plugin("p", () => ({
					commands: { cmd: () => Promise.resolve(1) },
					dispose: () => stopped.push("p"),
				})),
			],
			ctx,
		);
		host.dispose();
		expect(stopped).to.deep.equal(["p"]);
		expect(host.hasCommand("cmd")).to.equal(false);
	});
});
