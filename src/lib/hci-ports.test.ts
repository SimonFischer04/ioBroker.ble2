import { expect } from "chai";
import { getHciOptions, parseHciIndex, parseHciPorts } from "./hci-ports";

describe("Bluetooth adapter selection", () => {
	it("labels and sorts USB adapters by their HCI numbers", () => {
		const output = [
			"hci12:   Type: Primary  Bus: USB  ",
			"\tBD Address: 11:22:33:44:55:66 ACL MTU: 1021:8 SCO MTU: 64:1",
			"hci2:    Type: Primary  Bus: USB",
			"hci0:    Type: Primary  Bus: UART",
		].join("\r\n");

		expect(getHciOptions(parseHciPorts(output), 2)).to.deep.equal([
			{ value: 0, label: "hci0 (UART)" },
			{ value: 2, label: "hci2 (USB)" },
			{ value: 12, label: "hci12 (USB)" },
		]);
	});

	it("preserves a saved manual value when its device is detected", () => {
		const ports = parseHciPorts("hci2: Type: Primary Bus: USB");
		expect(getHciOptions(ports, "2")).to.deep.equal([
			{ value: "2", label: "hci2 (USB)" },
		]);
		expect(parseHciIndex("2")).to.equal(2);
	});

	it("preserves the selection if the configured adapter is unplugged", () => {
		const ports = parseHciPorts("hci0: Type: Primary Bus: USB");
		expect(getHciOptions(ports, 2)).to.deep.equal([
			{ value: 0, label: "hci0 (USB)" },
			{ value: 2, label: "hci2" },
		]);
	});

	it("allows manual input when there are no detected interfaces", () => {
		expect(getHciOptions(parseHciPorts(""), 0)).to.deep.equal([]);
		for (const invalid of ["", "hci2", "1.5", "-1", -1, Infinity]) {
			expect(parseHciIndex(invalid)).to.be.undefined;
		}
	});
});
