import type { PeripheralInfo } from "../../lib/scanProcessInterface";
import type { Plugin } from "../plugin";

const companyId = 0x0502;

interface BotReading {
	battery: number;
	passwordEnabled: boolean;
}

function readBot(peripheral: PeripheralInfo): BotReading | undefined {
	const data = peripheral.advertisement?.manufacturerData;
	if (!data || data.length !== 12 || data.readUInt16LE() !== companyId) {
		return;
	}
	const mac = peripheral.address?.replace(/[:-]/g, "").toLowerCase();
	const embeddedMac = data.subarray(2, 8);
	const reverse = Buffer.from(embeddedMac).reverse().toString("hex");
	if (!mac || (embeddedMac.toString("hex") !== mac && reverse !== mac)) {
		return;
	}
	const battery = data[8];
	const password = data[9];
	if (battery > 100 || password > 1) {
		return;
	}
	return { battery, passwordEnabled: password === 1 };
}

const plugin: Plugin<BotReading> = {
	name: "magicswitchbot",
	description: "MagicSwitchBot advertisements",
	advertisedServices: [],
	manufacturerIds: [companyId],
	isHandling: (peripheral) => readBot(peripheral) != null,
	createContext: readBot,
	defineObjects: () => ({
		device: { common: { name: "MagicSwitchBot" } },
		channels: undefined,
		states: [
			{
				id: "battery",
				common: {
					name: "Battery",
					role: "value.battery",
					type: "number",
					unit: "%",
					read: true,
					write: false,
				},
			},
			{
				id: "passwordEnabled",
				common: {
					name: "Device password enabled",
					role: "indicator",
					type: "boolean",
					read: true,
					write: false,
				},
			},
		],
	}),
	getValues: (reading) => ({ ...reading }),
};

export = plugin;
