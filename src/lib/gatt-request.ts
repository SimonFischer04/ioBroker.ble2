import type { SessionOptions } from "../connections/connection-manager";
import { normalizeAddress } from "./advertisement";
import { decodeBase64 } from "./base64";
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
		options: {
			// An explicitly named gateway is used even if it never reported the device
			gateways:
				gatewayId === undefined ? undefined : [gatewayId],
			addressType,
		},
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
		const bytes = decodeBase64(data);
		if (!bytes) {
			throw invalid(`"data" must be base64 encoded`);
		}
		if (withResponse !== undefined && typeof withResponse !== "boolean") {
			throw invalid(`"withResponse" must be true or false`);
		}
		request.data = bytes;
		request.withResponse = withResponse ?? true;
	}
	return request;
}

/**
 * Validates the payload of a command that addresses a device as a whole, e.g. the commands of
 * plugins. Throws GatewayError("INVALID_PAYLOAD").
 *
 * @param payload The message as received
 * @returns The device and the gateway and address type the caller asked for
 */
export function parseDeviceRequest(payload: unknown): {
	address: string;
	options: SessionOptions;
} {
	const { address, options } = parseGattRequest(payload, {
		characteristic: false,
		data: false,
	});
	return { address, options };
}

/**
 * Reads a whole number in a range from the payload. Throws GatewayError("INVALID_PAYLOAD").
 *
 * @param payload The message as received, already checked to be an object
 * @param key Name of the field
 * @param min Smallest allowed value
 * @param max Largest allowed value
 */
export function requireInteger(
	payload: unknown,
	key: string,
	min: number,
	max: number,
): number {
	const value = (payload as Record<string, unknown>)[key];
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < min ||
		value > max
	) {
		throw new GatewayError(
			"INVALID_PAYLOAD",
			`${key} must be a whole number from ${min} to ${max}`,
		);
	}
	return value;
}
