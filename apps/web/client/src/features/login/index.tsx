/**
 * Login feature slot, mounted by App.tsx last so it covers everything:
 * `LoginGate` (`#loginGate`), the sign-in shown while no model can run (no Step
 * credential and no usable custom model). See actions.ts for the host routes it drives.
 */

import "./login.css";

export { LoginGate } from "./LoginGate";
