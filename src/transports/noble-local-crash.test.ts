import { EventEmitter } from "node:events";
import { expect } from "chai";
import * as proxyquire from "proxyquire";
import type * as LocalModule from "./noble-local";
import type { TransportContext } from "./transport";

function fixture() {
	const children: EventEmitter[] = [];
	const statuses: string[] = [];
	const delays: number[] = [];
	const timers = new Map<number, () => void>();
	const { NobleLocalTransport } = proxyquire.noPreserveCache()<
		typeof LocalModule
	>("./noble-local", {
		"node:child_process": {
			fork: () => {
				const child = new EventEmitter();
				children.push(child);
				return child;
			},
		},
	});
	const ctx = {
		adapter: {
			config: {},
			log: { info: () => undefined, warn: () => undefined },
			setState: (_id: string, status: string) => {
				statuses.push(status);
				return Promise.resolve();
			},
			setTimeout: (callback: () => void, delay: number) => {
				delays.push(delay);
				timers.set(delays.length, callback);
				return delays.length;
			},
			clearTimeout: (timer: number) => timers.delete(timer),
		},
		gateways: { setConnected: () => undefined },
	} as unknown as TransportContext;
	const transport = new NobleLocalTransport(ctx, {
		services: [],
		manufacturerIds: [],
	});
	return { transport, children, statuses, delays, timers };
}

describe("Local scanner crash recovery", () => {
	it("marks native crashes as driver errors and retries with a growing delay", () => {
		const { transport, children, statuses, delays, timers } = fixture();
		transport.start();
		children[0].emit("exit", null, "SIGABRT");
		expect(statuses).to.deep.equal(["driverError"]);
		expect(delays).to.deep.equal([1000]);

		timers.get(1)?.();
		expect(children).to.have.length(2);
		children[1].emit("exit", null, "SIGSEGV");
		expect(delays).to.deep.equal([1000, 2000]);

		transport.stop();
		expect(timers.has(2)).to.equal(false);
		expect(children).to.have.length(2);
	});

	it("leaves an intentionally terminated scanner stopped", () => {
		const { transport, children, delays, statuses } = fixture();
		transport.start();
		children[0].emit("exit", null, "SIGTERM");
		expect(delays).to.deep.equal([]);
		expect(statuses).to.deep.equal([]);
	});
});
