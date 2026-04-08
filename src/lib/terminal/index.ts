// src/lib/terminal/index.ts
// Import once at WS server startup to register all providers.

import { providerRegistry } from './registry.js';
import { LocalProvider } from './providers/local.js';

providerRegistry.register(new LocalProvider());

export { providerRegistry };
