import type { Plugin } from "./plugin";
import xiaomi = require("./xiaomi");
import miFlora = require("./mi-flora");
import ruuviTag = require("./ruuvi-tag");
import switchbot = require("./switchbot");
import bthome = require("./bthome");
import mopeka = require("./mopeka");
import defaultPlugin = require("./_default");

export default [
	xiaomi,
	miFlora,
	ruuviTag,
	switchbot,
	bthome,
	mopeka,
	defaultPlugin,
] satisfies Plugin[];
