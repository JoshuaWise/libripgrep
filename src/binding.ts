// The shape of the native addon (prebuilds/<platform>-<arch>/libripgrep.node).
// Every entry point is currently a stub that always throws; signatures will
// be fleshed out as each implementation phase lands.
export interface NativeBinding {
	compileGlob(): never;
	grepBuffer(): never;
	walkTree(): never;
	grepTree(): never;
}
