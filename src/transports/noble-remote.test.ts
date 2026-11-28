import { expect } from "chai";
import { FrameReader } from "./noble-remote";

describe("transports/noble-remote => FrameReader", () => {
	it("splits the stream into lines and keeps the incomplete rest", () => {
		const reader = new FrameReader(100);
		expect(reader.push('{"a":1}\n{"b"')).to.deep.equal({
			lines: ['{"a":1}'],
			overflow: false,
		});
		expect(reader.push(":2}\n")).to.deep.equal({
			lines: ['{"b":2}'],
			overflow: false,
		});
	});

	it("accepts a chunk with many complete messages, however long it is", () => {
		const reader = new FrameReader(100);
		const line = JSON.stringify({ type: "log", message: "x".repeat(50) });
		const result = reader.push(`${line}\n`.repeat(100));
		expect(result.overflow).to.equal(false);
		expect(result.lines).to.have.lengthOf(100);
	});

	it("reports a message that gets too long without a newline and forgets it", () => {
		const reader = new FrameReader(100);
		expect(reader.push("x".repeat(60)).overflow).to.equal(false);
		expect(reader.push("x".repeat(60)).overflow).to.equal(true);
		// Starts over afterwards
		expect(reader.push('{"c":3}\n')).to.deep.equal({
			lines: ['{"c":3}'],
			overflow: false,
		});
	});
});
