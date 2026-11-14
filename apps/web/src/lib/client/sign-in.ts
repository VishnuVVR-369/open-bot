import { signInPath } from "../sign-in-return";

/** The tab was signed out (elsewhere, or the session ended): sign in, then come back to this page. */
export function goToSignIn() {
  const { pathname, search, hash } = window.location;
  window.location.assign(signInPath(`${pathname}${search}${hash}`));
}
