/**
 * What the office shows right now that panels outside it want to read: each
 * workstation's state (it depends on whether its person sits at it, which
 * only the scene knows). Written every frame, read by polling panels.
 */
export type DeskState = "off" | "sleep" | "on" | "working";
export const deskStates = new Map<string, DeskState>();
