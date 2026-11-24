import type { GattServiceInfo } from "../lib/gateway-protocol";

/** An open connection to a device through one gateway. All methods reject with a GatewayError. */
export interface GattLink {
	/** Full ID of the gateway, e.g. "esphome.0:proxy-og" */
	readonly gatewayId: string;
	readonly address: string;
	readonly mtu: number;
	getServices(): Promise<GattServiceInfo[]>;
	read(handle: number): Promise<Buffer>;
	write(handle: number, data: Buffer, withResponse: boolean): Promise<void>;
	/** Enables notifications of a characteristic. The listener is called for every notification. */
	subscribe(handle: number, listener: (data: Buffer) => void): Promise<void>;
	/** Ends the connection. Never rejects. */
	disconnect(): Promise<void>;
	/** The listener is called once when the connection ended without disconnect() being called */
	onDisconnect(listener: () => void): void;
}

/** Opens links through gateways */
export interface GattLinkProvider {
	/** @param gatewayId Full ID of the gateway */
	connect(
		gatewayId: string,
		address: string,
		addressType: "public" | "random",
	): Promise<GattLink>;
}
