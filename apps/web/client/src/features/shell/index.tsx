/**
 * Shell feature slots, mounted by App.tsx at their legacy DOM positions:
 * `UserArea` (`.user-area`: account, remote-control placeholder, settings gear), `SidebarShowButton` (`#sidebarShow`),
 * `ErrorToast` (`#errorToast`), `AuthBanner` (`#authBanner`),
 * `LogoutDialog` (`#logoutDialog`), `LoggedOutOverlay` (`#loggedOutOverlay`)
 * and `ShellEffects` (document listeners). See client/MIGRATION_MAP.md.
 */

import "./shell.css";

export { LogoutDialog } from "./LogoutDialog";
export { ShellEffects } from "./ShellEffects";
export { AuthBanner, ErrorToast, LoggedOutOverlay, SidebarShowButton } from "./Surfaces";
export { UserArea } from "./UserArea";
