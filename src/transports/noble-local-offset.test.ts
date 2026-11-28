import { EventEmitter } from "node:events";
import { expect } from "chai";
import * as proxyquire from "proxyquire";
import type * as LocalModule from "./noble-local";
import type { TransportContext } from "./transport";

describe("Local scanner offset errors", () => {
	it("keeps transient reports in debug logs and reports fatal failures as errors", () => {
		const child = new EventEmitter();
		const debug: string[] = [];
		const errors: string[] = [];
		const { NobleLocalTransport } = proxyquire.noPreserveCache()<
			typeof LocalModule
		>("./noble-local", {
			child_process: { fork: () => child },
		});
		const context = {
			adapter: {
				config: {},
				log: {
					info: () => undefined,
					debug: (message: string) => debug.push(message),
					error: (message: string) => errors.push(message),
				},
			},
		} as unknown as TransportContext;
		const transport = new NobleLocalTransport(context, {
			services: [],
			manufacturerIds: [],
		});
		transport.start();
		const offsetError =
			'The value of "offset" is out of range. It must be >= 0 and <= 2.';
		const report = (type: "error" | "fatal", message: string): void => {
			child.emit("message", {
				type,
				error: { type: "Error", name: "RangeError", message },
			});
		};

		report("error", offsetError);
		expect(debug).to.deep.equal([`Bluetooth scanner: ${offsetError}`]);
		expect(errors).to.be.empty;

		report("error", "Unexpected scanner error");
		report("fatal", offsetError);
		expect(errors).to.deep.equal([
			"Unexpected scanner error",
			`Bluetooth scanner: ${offsetError}`,
		]);
	});
});
