/**
 * Version of the published `ds4-context-core` package. The coordinated release
 * process bumps it together with both adapters, so an adapter can detect at
 * runtime that the core artifact it resolved is older than its own source
 * instead of failing later with a missing export.
 */
export const CORE_VERSION = "0.4.11";
