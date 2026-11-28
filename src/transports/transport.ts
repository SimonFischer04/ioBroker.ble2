import type { GatewayRegistry } from "../gateways/gateway-registry";
import type { PeripheralInfo } from "../lib/advertisement";

/** What a transport needs from the adapter */
export interface TransportContext {
	/** For logging, states and messages to other instances */
	adapter: ioBroker.Adapter;
	/** Where the transport reports its gateways and whether they are active */
	gateways: GatewayRegistry;
	/** Called for every received advertisement. `gatewayId` must be set. */
	onAdvertisement: (peripheral: PeripheralInfo) => void;
}

/** A source of BLE advertisements */
export interface Transport {
	/** Starts receiving advertisements */
	start(): void;
	/** Stops receiving advertisements for good */
	stop(): void;
}
