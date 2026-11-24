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
var time_sync_exports = {};
__export(time_sync_exports, {
  PvvxProtocolError: () => PvvxProtocolError,
  syncTime: () => syncTime,
  systemClock: () => systemClock
});
module.exports = __toCommonJS(time_sync_exports);
var import_protocol = require("./protocol");
const systemClock = {
  now: () => Date.now(),
  timezoneOffset: (atMs) => new Date(atMs).getTimezoneOffset()
};
class PvvxProtocolError extends Error {
  code = "UNEXPECTED_ANSWER";
  constructor(message) {
    super(message);
    this.name = "PvvxProtocolError";
  }
}
const MAX_SET_DEVIATION_S = 2;
async function syncTime(channel, clock) {
  const config = (0, import_protocol.parseConfigResponse)(
    await channel.request((0, import_protocol.encodeConfigRequest)())
  );
  if (!config) {
    throw new PvvxProtocolError(
      "The device did not answer like a pvvx firmware"
    );
  }
  const before = (0, import_protocol.parseTimeResponse)(
    await channel.request((0, import_protocol.encodeTimeRequest)())
  );
  if (!before) {
    throw new PvvxProtocolError("Invalid answer to reading the time");
  }
  let now = clock.now();
  const deviation = (0, import_protocol.clockDeviation)(
    before.clock,
    (0, import_protocol.localClockValue)(now, clock.timezoneOffset(now))
  );
  now = clock.now();
  const value = (0, import_protocol.localClockValue)(now, clock.timezoneOffset(now));
  const after = (0, import_protocol.parseTimeResponse)(
    await channel.request((0, import_protocol.encodeTimeRequest)(value))
  );
  if (!after || Math.abs((0, import_protocol.clockDeviation)(after.clock, value)) > MAX_SET_DEVIATION_S) {
    throw new PvvxProtocolError("The device did not take the time");
  }
  return {
    version: config.version,
    ...config.hardwareId !== void 0 ? { hardwareId: config.hardwareId } : {},
    deviation,
    value
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  PvvxProtocolError,
  syncTime,
  systemClock
});
//# sourceMappingURL=time-sync.js.map
