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
var test_image_exports = {};
__export(test_image_exports, {
  buildTestImage: () => buildTestImage
});
module.exports = __toCommonJS(test_image_exports);
var import_ota_protocol = require("./ota-protocol");
function buildTestImage(size) {
  if (!Number.isInteger(size) || size < 1024 || (size & 15) !== 4) {
    throw new Error(`${size} is not a valid image size`);
  }
  const image = Buffer.alloc(size);
  for (let i = 0; i < size; i++)
    image[i] = i * 7 + 3 & 255;
  image.write("KNLT", 8, "ascii");
  image.writeUInt32LE(size, 24);
  image.writeUInt32LE((0, import_ota_protocol.crc32Telink)(image.subarray(0, size - 4)), size - 4);
  return image;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  buildTestImage
});
//# sourceMappingURL=test-image.js.map
