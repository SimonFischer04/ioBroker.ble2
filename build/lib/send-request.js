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
var send_request_exports = {};
__export(send_request_exports, {
  sendRequest: () => sendRequest
});
module.exports = __toCommonJS(send_request_exports);
var import_gateway_error = require("./gateway-error");
function sendRequest(adapter, instance, command, message, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = adapter.setTimeout(() => {
      if (settled)
        return;
      settled = true;
      reject(
        new import_gateway_error.GatewayError(
          "TIMEOUT",
          `No answer to ${command} from ${instance} within ${timeoutMs} ms`
        )
      );
    }, timeoutMs);
    const settle = (fn) => {
      if (settled)
        return;
      settled = true;
      adapter.clearTimeout(timer);
      fn();
    };
    try {
      adapter.sendTo(instance, command, message, (response) => {
        settle(() => {
          const answer = response;
          if (answer != null && typeof answer === "object" && !(answer instanceof Error)) {
            if (answer.error === null && "result" in answer) {
              resolve(answer.result);
              return;
            }
            if (answer.error != null && typeof answer.error === "object" && typeof answer.error.code === "string") {
              reject(
                new import_gateway_error.GatewayError(
                  answer.error.code,
                  typeof answer.error.message === "string" ? answer.error.message : answer.error.code
                )
              );
              return;
            }
          }
          reject(
            new import_gateway_error.GatewayError(
              "GATT_ERROR",
              `Unexpected answer to ${command}`
            )
          );
        });
      });
    } catch (e) {
      settle(
        () => reject(
          new import_gateway_error.GatewayError(
            "GATT_ERROR",
            e instanceof Error ? e.message : String(e)
          )
        )
      );
    }
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  sendRequest
});
//# sourceMappingURL=send-request.js.map
