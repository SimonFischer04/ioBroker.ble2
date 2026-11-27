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

	it("starts the active parts and skips plugins without one", () => {
		const started: string[] = [];
		host.start(
			[
				plugin("a", () => {
					started.push("a");
					return {};
				}),
				plugin("b"),
				plugin("c", () => {
					started.push("c");
					return {};
				}),
			],
			ctx,
		);
		expect(started).to.deep.equal(["a", "c"]);
	});

	it("reports a plugin that fails to start and starts the others", () => {
		const started: string[] = [];
		host.start(
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
		host.start(
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
		expect(host.runCommand("other", {})).to.equal(undefined);
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
		host.start(
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
		expect(host.runCommand("getDevices", {})).to.equal(undefined);
		expect(await host.runCommand("shared", undefined)).to.deep.equal({
			error: null,
			result: "x",
		});
		expect(logs).to.have.lengthOf(2);
	});

	it("hands advertisements to every plugin, a failing one does not stop the others", () => {
		const seen: string[] = [];
		host.start(
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

	it("passes a state change to the plugins until one takes it", () => {
		const asked: string[] = [];
		const instance = (name: string, takes: boolean): PluginInstance => ({
			handleStateChange: () => {
				asked.push(name);
				return takes;
			},
		});
		host.start(
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

	it("registers the commands at once, also of a plugin that sets itself up in the background", () => {
		host.start(
			[
				plugin("slow", () => {
					void new Promise(() => {});
					return { commands: { cmd: () => Promise.resolve(1) } };
				}),
			],
			ctx,
		);
		expect(host.runCommand("cmd", undefined)).to.not.equal(undefined);
	});

	it("stops the plugins and forgets their commands", () => {
		const stopped: string[] = [];
		host.start(
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
		expect(host.runCommand("cmd", undefined)).to.equal(undefined);
	});
});
