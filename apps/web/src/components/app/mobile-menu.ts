"use client";

import { createContext, useContext } from "react";

/**
 * Opens the menu on screens too narrow for the sidebar. A page with its own toolbar, like a chat,
 * puts the menu button there, so a phone shows one bar instead of two.
 */
export const MobileMenuContext = createContext<(() => void) | null>(null);

export function useOpenMobileMenu() {
  return useContext(MobileMenuContext);
}
