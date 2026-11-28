import type { GattSession } from "../../../connections/gatt-session";
import { GatewayError, normalizeError } from "../../../lib/gateway-error";
import {
	PVVX_COMMAND_CHARACTERISTIC,
	PVVX_SERVICE,
	PVVX_WRITE_WITH_RESPONSE,
} from "./protocol";

const DEFAULT_TIMEOUT_MS = 10000;

/** Timer functions, replaceable so tests can control the request timeout */
export interface ChannelTimers {
	/** Calls callback after ms, returns a handle for clearTimeout() */
	setTimeout(callback: () => void, ms: number): unknown;
	/** Cancels a timer started with setTimeout() */
	clearTimeout(timer: any): void;
}

interface PendingRequest {
	command: number;
	resolve: (answer: Buffer) => void;
	reject: (error: unknown) => void;
	timer?: unknown;
}

/**
 * Commands of the pvvx firmware: a request is written to the command characteristic, the answer is the
 * notification that starts with the same byte. The device sends other notifications in between, e.g. measurements.
 */
export class PvvxCommandChannel {
	/**
	 * Uses an open GATT session to the device; timers are injected for the request timeout.
	 *
	 * @param session Connection to the device
	 * @param timers Timer functions for the request timeout
	 */
	public constructor(
		private readonly session: GattSession,
		private readonly timers: ChannelTimers,
	) {}

	private pending: PendingRequest | undefined;

	/** Enables notifications of the command characteristic. Must be called once, before request(). */
	public open(): Promise<void> {
		return this.session.subscribe(
			PVVX_SERVICE,
			PVVX_COMMAND_CHARACTERISTIC,
			(data) => this.onNotification(data),
		);
	}

	/**
	 * Writes the request and resolves with the first notification whose first byte equals the first byte of the request.
	 * Other notifications are skipped. Rejects with GatewayError("TIMEOUT") after timeoutMs.
	 * Only one request at a time: a second call while one is running rejects with GatewayError("GATT_ERROR").
	 *
	 * @param data Request, the first byte is the command
	 * @param timeoutMs How long to wait for the answer
	 */
	public request(
		data: Buffer,
		timeoutMs: number = DEFAULT_TIMEOUT_MS,
	): Promise<Buffer> {
		if (this.pending) {
			return Promise.reject(
				new GatewayError(
					"GATT_ERROR",
					`Command 0x${hexByte(this.pending.command)} is still running`,
				),
			);
		}
		const command = data[0];
		return new Promise<Buffer>((resolve, reject) => {
			const pending: PendingRequest = { command, resolve, reject };
			// Expect the answer before writing: it may arrive before the write is confirmed
			this.pending = pending;
			pending.timer = this.timers.setTimeout(() => {
				if (this.pending !== pending) {
					return;
				}
				this.pending = undefined;
				reject(
					new GatewayError(
						"TIMEOUT",
						`No answer to command 0x${hexByte(command)} within ${timeoutMs} ms`,
					),
				);
			}, timeoutMs);

			this.session
				.write(
					PVVX_SERVICE,
					PVVX_COMMAND_CHARACTERISTIC,
					data,
					PVVX_WRITE_WITH_RESPONSE,
				)
				.catch((error: unknown) => {
					if (this.pending !== pending) {
						return;
					}
					this.pending = undefined;
					this.timers.clearTimeout(pending.timer);
					reject(normalizeError(error));
				});
		});
	}

	private onNotification(data: Buffer): void {
		const pending = this.pending;
		if (!pending || data.length === 0 || data[0] !== pending.command) {
			return;
		}
		this.pending = undefined;
		this.timers.clearTimeout(pending.timer);
		pending.resolve(data);
	}
}

function hexByte(value: number): string {
	return value.toString(16).padStart(2, "0");
}
