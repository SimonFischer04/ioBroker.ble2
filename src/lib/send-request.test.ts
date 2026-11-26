import { expect } from "chai";
import { GatewayError, toErrorResponse } from "./gateway-error";
import { sendRequest, type RequestSender } from "./send-request";

/** Records what is sent and lets the test answer and expire timers */
class FakeSender implements RequestSender {
	public readonly sent: {
		instance: string;
		command: string;
		message: unknown;
		callback: (response: unknown) => void;
	}[] = [];
	public readonly timers = new Map<number, () => void>();
	public readonly cleared: number[] = [];
	public throwOnSend: Error | undefined;
	private nextTimer = 1;

	public sendTo(
		instance: string,
		command: string,
		message: unknown,
		callback: (response: unknown) => void,
	): void {
		if (this.throwOnSend) {
			throw this.throwOnSend;
		}
		this.sent.push({ instance, command, message, callback });
	}

	public setTimeout(callback: () => void): number {
		const id = this.nextTimer++;
		this.timers.set(id, callback);
		return id;
	}

	public clearTimeout(timer: number): void {
		this.cleared.push(timer);
		this.timers.delete(timer);
	}

	public answer(response: unknown): void {
		this.sent[this.sent.length - 1].callback(response);
	}

	public expire(): void {
		for (const [id, callback] of [...this.timers]) {
			this.timers.delete(id);
			callback();
		}
	}
}

async function rejection(promise: Promise<unknown>): Promise<GatewayError> {
	try {
		await promise;
	} catch (e) {
		expect(e).to.be.instanceOf(GatewayError);
		return e as GatewayError;
	}
	throw new Error("the promise did not reject");
}

describe("lib/send-request => sendRequest()", () => {
	it("sends the command and resolves with the result", async () => {
		const sender = new FakeSender();
		const promise = sendRequest(
			sender,
			"test.0",
			"gatt:read",
			{ handle: 1 },
			1000,
		);
		expect(sender.sent[0]).to.include({
			instance: "test.0",
			command: "gatt:read",
		});
		expect(sender.sent[0].message).to.deep.equal({ handle: 1 });
		sender.answer({ error: null, result: { data: "AQ==" } });
		expect(await promise).to.deep.equal({ data: "AQ==" });
	});

	it("clears the timer when the answer arrives", async () => {
		const sender = new FakeSender();
		const promise = sendRequest(sender, "test.0", "gatt:read", {}, 1000);
		sender.answer({ error: null, result: {} });
		await promise;
		expect(sender.timers.size).to.equal(0);
		expect(sender.cleared).to.deep.equal([1]);
	});

	it("settles once: an answer after the timeout is ignored", async () => {
		const sender = new FakeSender();
		const promise = sendRequest(sender, "test.0", "gatt:read", {}, 1000);
		sender.expire();
		sender.answer({ error: null, result: {} });
		const error = await rejection(promise);
		expect(error.code).to.equal("TIMEOUT");
		expect(error.message).to.include("gatt:read");
	});

	it("rejects with the error of the answer", async () => {
		const sender = new FakeSender();
		const promise = sendRequest(sender, "test.0", "gatt:connect", {}, 1000);
		sender.answer({ error: { code: "NO_FREE_SLOT", message: "all busy" } });
		const error = await rejection(promise);
		expect(error.code).to.equal("NO_FREE_SLOT");
		expect(error.message).to.equal("all busy");
	});

	it("rejects answers of an unknown form with GATT_ERROR", async () => {
		for (const response of [
			undefined,
			new Error("Timeout exceeded"),
			{ error: "Unknown command!" },
			{ result: {} },
			"ok",
		]) {
			const sender = new FakeSender();
			const promise = sendRequest(
				sender,
				"test.0",
				"gatt:read",
				{},
				1000,
			);
			sender.answer(response);
			const error = await rejection(promise);
			expect(error.code, JSON.stringify(response)).to.equal("GATT_ERROR");
			expect(error.message).to.equal("Unexpected answer to gatt:read");
		}
	});

	it("rejects with GATT_ERROR when sending fails", async () => {
		const sender = new FakeSender();
		sender.throwOnSend = new Error("not connected to the DB");
		const error = await rejection(
			sendRequest(sender, "test.0", "gatt:read", {}, 1000),
		);
		expect(error.code).to.equal("GATT_ERROR");
		expect(error.message).to.equal("not connected to the DB");
		expect(sender.timers.size).to.equal(0);
	});
});

describe("lib/gateway-error => toErrorResponse()", () => {
	it("keeps the code of a GatewayError", () => {
		expect(toErrorResponse(new GatewayError("TIMEOUT", "x"))).to.deep.equal(
			{
				error: { code: "TIMEOUT", message: "x" },
			},
		);
	});

	it("turns everything else into GATT_ERROR", () => {
		expect(toErrorResponse(new Error("boom"))).to.deep.equal({
			error: { code: "GATT_ERROR", message: "boom" },
		});
		expect(toErrorResponse("text")).to.deep.equal({
			error: { code: "GATT_ERROR", message: "text" },
		});
	});
});
