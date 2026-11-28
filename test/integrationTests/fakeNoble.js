const { EventEmitter } = require("node:events");
const { registerHooks } = require("node:module");
const { pathToFileURL } = require("node:url");

const noble = new EventEmitter();
noble.state = "poweredOn";
noble.startScanningAsync = () => {
	const id = "aabbccddeeff";
	const peripheral = {
		id,
		uuid: id,
		address: "aa:bb:cc:dd:ee:ff",
		addressType: "public",
		rssi: -48,
	};
	// Noble normally emits only the merged result, after the scan response
	// has overwritten the manufacturer data from the advertisement.
	if (process.env.NOBLE_REPORT_ALL_HCI_EVENTS) {
		noble.emit("discover", {
			...peripheral,
			advertisement: {
				manufacturerData: Buffer.from("88ec0003d6ba3800", "hex"),
			},
		});
	}
	noble.emit("discover", {
		...peripheral,
		advertisement: {
			serviceUuids: ["ec88"],
			manufacturerData: Buffer.from(
				"4c000215494e54454c4c495f524f434b535f48575075f2ff0c",
				"hex",
			),
		},
	});
	return Promise.resolve();
};

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "@stoprocent/noble") {
			return { url: pathToFileURL(__filename).href, shortCircuit: true };
		}
		return nextResolve(specifier, context);
	},
});

module.exports = noble;
