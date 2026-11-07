// Plaid Sandbox integration: client (official `plaid` package), HTTP routes and the store behind the plaid_sync workflow.
// Importing this module registers the /plaid/* routes on the shared router; call attachPlaid(conn) once the worker is connected.
import './routes.js';

export { attachPlaid, getPlaidRuntime, setPlaidRuntime, resetPlaidRuntime } from './runtime.js';
