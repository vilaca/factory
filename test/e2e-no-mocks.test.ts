/**
 * E2E tests that don't initiate any network connection. The CLI exits
 * before opening a socket — useful for asserting argv parsing, --help,
 * --version, error formatting on bad flags, and similar surface-level
 * behaviour.
 *
 * No tests live here yet. Add new ones whenever you have an end-to-end
 * assertion that the CLI can satisfy without ever touching the network.
 */

export {};
