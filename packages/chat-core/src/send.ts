/**
 * The id a message is sent with. Sending the same thing again reuses the earlier attempt's id, so
 * a message whose answer was lost is saved once; anything else gets a new id.
 */
export interface SendAttempt {
  key: string;
  clientId: string;
}

/**
 * `parts` identify the message (chat, text, attachments, ...). `previous` is the attempt a resend
 * may reuse: the composers keep only a failed one, so a message sent again after a success is new.
 */
export function sendAttempt(
  previous: SendAttempt | null,
  parts: unknown,
  newId: () => string,
): SendAttempt {
  const key = JSON.stringify(parts);
  return { key, clientId: previous?.key === key ? previous.clientId : newId() };
}
