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
var gateway_error_exports = {};
__export(gateway_error_exports, {
  GatewayError: () => GatewayError,
  toErrorResponse: () => toErrorResponse
});
module.exports = __toCommonJS(gateway_error_exports);
class GatewayError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "GatewayError";
  }
}
function toErrorResponse(error) {
  if (error instanceof GatewayError) {
    return { error: { code: error.code, message: error.message } };
  }
  const message = error instanceof Error ? error.message : String(error != null ? error : "Unknown error");
  return { error: { code: "GATT_ERROR", message } };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  GatewayError,
  toErrorResponse
});
//# sourceMappingURL=gateway-error.js.map
