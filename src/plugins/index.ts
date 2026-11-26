import type { Plugin } from "./plugin";
import xiaomi = require("./xiaomi");
import miFlora = require("./mi-flora");
import eddystone = require("./eddystone");
import ruuviTag = require("./ruuvi-tag");
import switchbot = require("./switchbot");
import bthome = require("./bthome");
import mopeka = require("./mopeka");
import defaultPlugin = require("./_default");

export default [
	xiaomi,
	miFlora,
	eddystone,
	ruuviTag,
	switchbot,
	bthome,
	mopeka,
	defaultPlugin,
] satisfies Plugin[];
