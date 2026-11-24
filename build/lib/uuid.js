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
var uuid_exports = {};
__export(uuid_exports, {
  normalizeUuid: () => normalizeUuid
});
module.exports = __toCommonJS(uuid_exports);
const BASE_UUID_SUFFIX = "-0000-1000-8000-00805f9b34fb";
function normalizeUuid(uuid) {
  if (typeof uuid !== "string")
    return void 0;
  const text = uuid.trim().toLowerCase().replace(/^0x/, "");
  if (/^[0-9a-f]{4}$/.test(text))
    return `0000${text}${BASE_UUID_SUFFIX}`;
  if (/^[0-9a-f]{8}$/.test(text))
    return `${text}${BASE_UUID_SUFFIX}`;
  if (/^[0-9a-f]{32}$/.test(text)) {
    return [
      text.slice(0, 8),
      text.slice(8, 12),
      text.slice(12, 16),
      text.slice(16, 20),
      text.slice(20)
    ].join("-");
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
    text
  )) {
    return text;
  }
  return void 0;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  normalizeUuid
});
//# sourceMappingURL=uuid.js.map
