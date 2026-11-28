import type { PeripheralInfo } from "../lib/advertisement";
import type { Plugin } from "./plugin";

// The original iGrill mini advertises its temperature service UUID.
const IGRILL_MINI_SERVICE = "63c700004a82426195ff92cf32477861";

const plugin: Plugin<undefined> = {
	name: "igrill",
	description: "Weber iGrill mini discovery",
	advertisedServices: [IGRILL_MINI_SERVICE],
	isHandling: (peripheral: PeripheralInfo) =>
		peripheral.advertisement?.serviceUuids?.includes(IGRILL_MINI_SERVICE) ??
		false,
	createContext: () => undefined,
	defineObjects: () => ({
		device: { common: { name: "Weber iGrill mini" } },
		channels: undefined,
		states: [],
	}),
	getValues: () => undefined,
};

export = plugin as Plugin;
