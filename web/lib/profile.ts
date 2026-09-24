/**
 * Profile name used to sign AI-generated drafts. Stored in app_state; in the
 * public demo each visitor gets their own key so one visitor's edit never
 * changes another visitor's drafts. Visitors without a value fall back to
 * the owner's.
 */
import { getAppState, setAppState } from "./db";
import { OWNER_DEMO_USER } from "./demo";

const BASE_KEY = "user_profile_name";

function keyFor(user: string): string {
  return user === OWNER_DEMO_USER ? BASE_KEY : `${BASE_KEY}:${user}`;
}

export function getProfileName(user: string): string {
  const own = getAppState(keyFor(user));
  if (own !== null) return own.trim();
  return (getAppState(BASE_KEY) || "").trim();
}

export function setProfileName(user: string, value: string): void {
  setAppState(keyFor(user), value);
}
