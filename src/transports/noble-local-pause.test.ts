import { EventEmitter } from "node:events";
import { expect } from "chai";
import * as proxyquire from "proxyquire";
import type * as LocalModule from "./noble-local";
import type { TransportContext } from "./transport";

class Scanner extends EventEmitter {
	public stopped = false;
	public kill(): boolean {
		this.stopped = true;
		return true;
	}
}

describe("A paused local scanner", () => {
	it("acknowledges pause after the process exits and resumes once", () => {
		const children: Scanner[] = [];
		const acknowledgements: boolean[] = [];
		const { NobleLocalTransport } = proxyquire.noPreserveCache()<
			typeof LocalModule
		>("./noble-local", {
			child_process: {
				fork: () => {
					const child = new Scanner();
					children.push(child);
					return child;
				},
			},
		});
		const ctx = {
			adapter: {
				config: {},
				log: { info: () => undefined },
				setState: (_id: string, value: boolean) => {
					acknowledgements.push(value);
					return Promise.resolve();
				},
			},
			gateways: { setConnected: () => undefined },
		} as unknown as TransportContext;
		const scanner = new NobleLocalTransport(ctx, {
			services: [],
			manufacturerIds: [],
		});
		scanner.start();
		scanner.setPaused(true);
		expect(children[0].stopped).to.equal(true);
		expect(acknowledgements).to.deep.equal([]);
		children[0].emit("exit", null, "SIGTERM");
		expect(acknowledgements).to.deep.equal([true]);
		expect(children).to.have.length(1);
		scanner.setPaused(false);
		expect(children).to.have.length(2);

		scanner.setPaused(true);
		scanner.setPaused(false);
		expect(children).to.have.length(2);
		children[1].emit("exit", null, "SIGTERM");
		expect(children).to.have.length(3);
		expect(acknowledgements).to.deep.equal([true, false, false]);
		scanner.stop();
		children[2].emit("exit", null, "SIGTERM");
		scanner.start();
		expect(children).to.have.length(3);
	});
});
