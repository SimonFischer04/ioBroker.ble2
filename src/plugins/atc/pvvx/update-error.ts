/** An error of the firmware update, code as in docs/spec-phase-4-pvvx-ota.md section 2 */
export class PvvxUpdateError extends Error {
	/**
	 * Creates the error with its machine-readable code.
	 *
	 * @param code Error code, e.g. "BATTERY_LOW"
	 * @param message Text for the user
	 */
	public constructor(
		public readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "PvvxUpdateError";
	}
}
