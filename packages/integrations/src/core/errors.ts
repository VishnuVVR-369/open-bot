/** A problem the teammate can act on (or tell the user about), said plainly. */
export class AccountToolError extends Error {
  constructor(
    message: string,
    /** The same problem said to you, as Settings shows it. */
    readonly ownerMessage: string = message,
  ) {
    super(message);
  }
}
