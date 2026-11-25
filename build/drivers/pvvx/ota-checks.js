"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var ota_checks_exports = {};
__export(ota_checks_exports, {
  MAX_BATTERY_AGE_MS: () => MAX_BATTERY_AGE_MS,
  MIN_BATTERY_PERCENT: () => MIN_BATTERY_PERCENT,
  MIN_RSSI: () => MIN_RSSI,
  checkPreconditions: () => checkPreconditions
});
module.exports = __toCommonJS(ota_checks_exports);
var import_update_error = require("./update-error");
const MIN_BATTERY_PERCENT = 40;
const MAX_BATTERY_AGE_MS = 36e5;
const MIN_RSSI = -80;
function checkPreconditions(input) {
  const { address, now, battery, bestGateway } = input;
  if (!bestGateway) {
    throw new import_update_error.PvvxUpdateError(
      "NO_GATEWAY",
      "No gateway that can update firmware receives the device"
    );
  }
  if (bestGateway.rssi < MIN_RSSI) {
    throw new import_update_error.PvvxUpdateError(
      "WEAK_SIGNAL",
      `${bestGateway.gatewayId} receives the device with ${bestGateway.rssi} dBm, at least ${MIN_RSSI} dBm are needed`
    );
  }
  if (!battery || typeof battery.val !== "number" || now - battery.ts > MAX_BATTERY_AGE_MS) {
    throw new import_update_error.PvvxUpdateError(
      "BATTERY_UNKNOWN",
      `No current battery value in ${address}.battery. The device must send its battery level, e.g. in the BTHome format.`
    );
  }
  if (battery.val < MIN_BATTERY_PERCENT) {
    throw new import_update_error.PvvxUpdateError(
      "BATTERY_LOW",
      `The battery is at ${battery.val} %, at least ${MIN_BATTERY_PERCENT} % are needed`
    );
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MAX_BATTERY_AGE_MS,
  MIN_BATTERY_PERCENT,
  MIN_RSSI,
  checkPreconditions
});
//# sourceMappingURL=ota-checks.js.map
