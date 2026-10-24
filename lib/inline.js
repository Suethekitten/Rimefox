// Both execution worlds import the same classic-script implementation.
import './inline-protocol.js';

export const INLINE_VERSION = globalThis.__RimefoxInline.version;
export const inspectInline = globalThis.__RimefoxInline.inspect;
