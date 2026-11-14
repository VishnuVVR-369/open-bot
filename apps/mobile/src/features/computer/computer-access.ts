import { createContext } from "react";

/** An app lock also stops the WebView behind it from receiving input or reconnecting. */
export const ComputerAccess = createContext(true);
