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
var command_channel_exports = {};
__export(command_channel_exports, {
  PvvxCommandChannel: () => PvvxCommandChannel
});
module.exports = __toCommonJS(command_channel_exports);
var import_gateway_error = require("../../lib/gateway-error");
var import_protocol = require("./protocol");
const DEFAULT_TIMEOUT_MS = 1e4;
class PvvxCommandChannel {
  constructor(session, timers) {
    this.session = session;
    this.timers = timers;
  }
  pending;
  open() {
    return this.session.subscribe(
      import_protocol.PVVX_SERVICE,
      import_protocol.PVVX_COMMAND_CHARACTERISTIC,
      (data) => this.onNotification(data)
    );
  }
  request(data, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (this.pending) {
      return Promise.reject(
        new import_gateway_error.GatewayError(
          "GATT_ERROR",
          `Command 0x${hexByte(this.pending.command)} is still running`
        )
      );
    }
    const command = data[0];
    return new Promise((resolve, reject) => {
      const pending = { command, resolve, reject };
      this.pending = pending;
      pending.timer = this.timers.setTimeout(() => {
        if (this.pending !== pending)
          return;
        this.pending = void 0;
        reject(
          new import_gateway_error.GatewayError(
            "TIMEOUT",
            `No answer to command 0x${hexByte(command)} within ${timeoutMs} ms`
          )
        );
      }, timeoutMs);
      this.session.write(
        import_protocol.PVVX_SERVICE,
        import_protocol.PVVX_COMMAND_CHARACTERISTIC,
        data,
        import_protocol.PVVX_WRITE_WITH_RESPONSE
      ).catch((error) => {
        if (this.pending !== pending)
          return;
        this.pending = void 0;
        this.timers.clearTimeout(pending.timer);
        reject(error);
      });
    });
  }
  onNotification(data) {
    const pending = this.pending;
    if (!pending || data.length === 0 || data[0] !== pending.command) {
      return;
    }
    this.pending = void 0;
    this.timers.clearTimeout(pending.timer);
    pending.resolve(data);
  }
}
function hexByte(value) {
  return value.toString(16).padStart(2, "0");
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  PvvxCommandChannel
});
//# sourceMappingURL=command-channel.js.map
