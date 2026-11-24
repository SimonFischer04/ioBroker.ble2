import { expect } from "chai";
import {
	DEFAULT_SERVER_PORT,
	migrateServerSettings,
	parseServer,
	parseServerList,
} from "./server-list";

describe("transports/server-list => parseServer()", () => {
	it("accepts host and port", () => {
		expect(parseServer("192.168.1.20:9000")).to.deep.equal({
			host: "192.168.1.20",
			port: 9000,
			gatewayId: "server:192.168.1.20:9000",
		});
	});

	it("uses the default port when there is none", () => {
		expect(DEFAULT_SERVER_PORT).to.equal(8734);
		expect(parseServer("pi-keller")).to.deep.equal({
			host: "pi-keller",
			port: 8734,
			gatewayId: "server:pi-keller:8734",
		});
	});

	it("accepts host names with domains and writes them in lowercase", () => {
		expect(parseServer("Pi-Keller.fritz.box:8734")?.gatewayId).to.equal(
			"server:pi-keller.fritz.box:8734",
		);
	});

	it("accepts IPv6 addresses in brackets", () => {
		expect(parseServer("[fd00::20]:9000")).to.deep.equal({
			host: "fd00::20",
			port: 9000,
			gatewayId: "server:fd00::20:9000",
		});
		expect(parseServer("[FD00::20]")?.port).to.equal(8734);
	});

	it("rejects everything else", () => {
		for (const entry of [
			"",
			":8734",
			"host:",
			"host:0",
			"host:65536",
			"host:80a",
			"host:1:2",
			"fd00::20",
			"[fd00::20]:",
			"[host]:8734",
			"-host",
			"host_name",
			"http://host:8734",
		]) {
			expect(parseServer(entry), entry).to.be.undefined;
		}
	});
});

describe("transports/server-list => parseServerList()", () => {
	it("splits at commas, semicolons, spaces and line breaks", () => {
		const { servers, invalid } = parseServerList(
			"pi-keller, pi-og:9000;\n[fd00::20]  pi-garage\r\n",
		);
		expect(servers.map((s) => s.gatewayId)).to.deep.equal([
			"server:pi-keller:8734",
			"server:pi-og:9000",
			"server:fd00::20:8734",
			"server:pi-garage:8734",
		]);
		expect(invalid).to.deep.equal([]);
	});

	it("removes duplicates, also with and without the default port", () => {
		const { servers } = parseServerList(
			"pi-keller pi-keller:8734 PI-KELLER",
		);
		expect(servers).to.have.length(1);
	});

	it("returns invalid entries separately", () => {
		const { servers, invalid } = parseServerList(
			"pi-keller, host:99999, a:b:c",
		);
		expect(servers.map((s) => s.host)).to.deep.equal(["pi-keller"]);
		expect(invalid).to.deep.equal(["host:99999", "a:b:c"]);
	});

	it("handles missing and empty settings", () => {
		for (const setting of [undefined, null, "", "  \n ", 8734]) {
			expect(parseServerList(setting), String(setting)).to.deep.equal({
				servers: [],
				invalid: [],
			});
		}
	});
});

describe("transports/server-list => migrateServerSettings()", () => {
	it("moves the old single server to the list and keeps the local Bluetooth adapter off", () => {
		// The upgrade adds the new settings with their defaults
		expect(
			migrateServerSettings({
				server: " 192.168.1.20:8734 ",
				remoteServers: "",
				localScanner: true,
			}),
		).to.deep.equal({
			server: "",
			remoteServers: "192.168.1.20:8734",
			localScanner: false,
		});
		// Or not, depending on the version of js-controller
		expect(migrateServerSettings({ server: "pi:8734" })).to.deep.equal({
			server: "",
			remoteServers: "pi:8734",
			localScanner: false,
		});
	});

	it("does nothing without the old setting", () => {
		expect(migrateServerSettings({})).to.be.undefined;
		expect(migrateServerSettings({ server: "" })).to.be.undefined;
		expect(migrateServerSettings({ server: "  " })).to.be.undefined;
		expect(migrateServerSettings({ remoteServers: "pi" })).to.be.undefined;
	});

	it("does nothing when the new setting is already used", () => {
		expect(
			migrateServerSettings({ server: "old:8734", remoteServers: "pi" }),
		).to.be.undefined;
	});
});
