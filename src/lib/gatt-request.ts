import type { SessionOptions } from "../connections/connection-manager";
import { BASE64_REGEX } from "../transports/remote-gateway";
import { normalizeAddress } from "./advertisement";
import { GatewayError } from "./gateway-error";
import { normalizeUuid } from "./uuid";

/** A validated request for one of the GATT commands */
export interface GattRequest {
	/** MAC address of the device, lowercase with colons */
	address: string;
	/** Canonical UUID of the service, "" if the command has none */
	service: string;
	/** Canonical UUID of the characteristic, "" if the command has none */
	characteristic: string;
	/** The value to write, empty if the command writes nothing */
	data: Buffer;
	/** Whether the device confirms the write */
	withResponse: boolean;
	/** Gateway and address type the caller asked for, passed on to the session */
	options: SessionOptions;
}

/**
 * Validates the payload of a GATT command (discoverServices, readCharacteristic, writeCharacteristic and
 * the commands of plugins) before anything is connected. Throws GatewayError("INVALID_PAYLOAD").
 *
 * @param payload The message as received
 * @param fields Which fields the command needs besides the address
 * @param fields.characteristic Whether service and characteristic are required
 * @param fields.data Whether data (and optionally withResponse) is required
 */
export function parseGattRequest(
	payload: unknown,
	fields: { characteristic: boolean; data: boolean },
): GattRequest {
	const invalid = (message: string): GatewayError =>
		new GatewayError("INVALID_PAYLOAD", message);
	if (payload == null || typeof payload !== "object") {
		throw invalid("The message must be an object");
	}
	const {
		address,
		service,
		characteristic,
		data,
		withResponse,
		gatewayId,
		addressType,
	} = payload as Record<string, unknown>;

	const normalizedAddress = normalizeAddress(address);
	if (!normalizedAddress) {
		throw invalid(`"address" must be a MAC address`);
	}
	if (
		gatewayId !== undefined &&
		(typeof gatewayId !== "string" || !gatewayId.trim())
	) {
		throw invalid('"gatewayId" must be a gateway identifier');
	}
	if (
		addressType !== undefined &&
		addressType !== "public" &&
		addressType !== "random"
	) {
		throw invalid('"addressType" must be public or random');
	}
	const request: GattRequest = {
		address: normalizedAddress,
		service: "",
		characteristic: "",
		data: Buffer.alloc(0),
		withResponse: true,
		options: { gatewayId, addressType },
	};
	if (fields.characteristic) {
		const serviceUuid = normalizeUuid(service);
		const characteristicUuid = normalizeUuid(characteristic);
		if (!serviceUuid) {
			throw invalid(`"service" must be a UUID`);
		}
		if (!characteristicUuid) {
			throw invalid(`"characteristic" must be a UUID`);
		}
		request.service = serviceUuid;
		request.characteristic = characteristicUuid;
	}
	if (fields.data) {
		if (typeof data !== "string" || !BASE64_REGEX.test(data)) {
			throw invalid(`"data" must be base64 encoded`);
		}
		if (withResponse !== undefined && typeof withResponse !== "boolean") {
			throw invalid(`"withResponse" must be true or false`);
		}
		request.data = Buffer.from(data, "base64");
		request.withResponse = withResponse ?? true;
	}
	return request;
}
