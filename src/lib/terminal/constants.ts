// src/lib/terminal/constants.ts
// Shared string constants with NO native module imports.
// Safe to import in client-side React components (avoids Turbopack bundling node-pty).

/** Stable ID for the local machine provider. Must match DB schema DEFAULT for host_id. */
export const LOCAL_PROVIDER_ID = 'local';
