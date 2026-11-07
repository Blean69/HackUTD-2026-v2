// The shared HTTP router. Route modules (e.g. a future /plaid/* module) import this and register themselves:
//   import { router } from './router.js';  router.addPrefix('POST', '/plaid/', handler);
// before the server starts (src/index.ts imports every route module at the top).
import { Router } from './http.js';

export const router = new Router();
