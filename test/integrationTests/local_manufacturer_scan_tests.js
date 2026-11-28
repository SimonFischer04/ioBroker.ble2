// @ts-check

const { fork } = require("node:child_process");
const { join } = require("node:path");
const { expect } = require("chai");
const { getMessageReviver } = require("../../build/lib/scanProcessInterface");
const govee = require("../../build/plugins/govee");

/** @import { IntegrationTestHarness } from "@iobroker/testing" */
/** @import { ScanMessage } from "../../src/lib/scanProcessInterface" */

/**
 * Exercises the real scanner with simulated reports from Noble.
 *
 * @param {(name: string, fn: (getHarness: () => IntegrationTestHarness) => void) => void} suite - Defines a suite
 */
exports.runTests = function (suite) {
	suite("Local manufacturer scan", () => {
		it("passes the H5075 measurement through before the scan response", async function () {
			this.timeout(10000);
			const env = { ...process.env };
			delete env.NOBLE_REPORT_ALL_HCI_EVENTS;
			const scanner = fork(
				join(__dirname, "../../build/scanProcess.js"),
				["--services", "ec88", "--manufacturerIds", "60552"],
				{
					env,
					execArgv: ["--require", join(__dirname, "fakeNoble.js")],
					signal: AbortSignal.timeout(5000),
					stdio: "ignore",
				},
			);
			try {
				const received = await new Promise((resolve, reject) => {
					const packets = [];
					scanner.once("error", reject);
					scanner.once("exit", (code) =>
						reject(new Error(`Scanner exited with code ${code}`)),
					);
					/** @param {ScanMessage} msg - The scanner message */
					function handleMessage(msg) {
						if (msg.type === "discover") {
							packets.push(msg.peripheral);
						} else if (msg.type === "connected") {
							resolve(packets);
						} else if (
							msg.type === "error" ||
							msg.type === "fatal"
						) {
							reject(msg.error);
						}
					}
					scanner.on("message", getMessageReviver(handleMessage));
				});
				expect(received).to.have.length(2);
				expect(govee.createContext(received[0])).to.deep.equal({
					temperature: 25.1,
					humidity: 57.8,
					battery: 56,
				});
				expect(govee.isHandling(received[1])).to.equal(false);
			} finally {
				scanner.kill();
			}
		});
	});
};
