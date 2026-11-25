/** An error of the firmware update, code as in docs/spec-phase-4-pvvx-ota.md section 2 */
export class PvvxUpdateError extends Error {
	public constructor(
		public readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "PvvxUpdateError";
	}
}
