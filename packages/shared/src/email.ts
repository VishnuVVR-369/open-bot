/** An email as it arrives, from Postmark's inbound webhook or anything that sends the same JSON. */
export interface InboundEmail {
  from: { email: string; name: string };
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  messageId: string | null;
  inReplyTo: string | null;
  attachments: { name: string; contentType: string; base64: string }[];
}

interface PostmarkAddress {
  Email?: string;
  Name?: string;
}

/** Plain text from an email's HTML, for when it has no text part. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function addresses(full: unknown, plain: unknown): string[] {
  if (Array.isArray(full))
    return full
      .map((entry) =>
        String((entry as PostmarkAddress).Email ?? "")
          .trim()
          .toLowerCase(),
      )
      .filter(Boolean);
  return String(plain ?? "")
    .split(",")
    .map((part) => (/<([^>]+)>/.exec(part)?.[1] ?? part).trim().toLowerCase())
    .filter((part) => part.includes("@"));
}

/** Reads Postmark's inbound JSON. Null when it isn't an email. */
export function parseInboundEmail(payload: unknown): InboundEmail | null {
  if (!payload || typeof payload !== "object") return null;
  const body = payload as Record<string, unknown>;
  const fromFull = body.FromFull as PostmarkAddress | undefined;
  const fromEmail = String(fromFull?.Email ?? addresses(null, body.From)[0] ?? "").toLowerCase();
  if (!fromEmail.includes("@")) return null;
  const to = addresses(body.ToFull, body.To);
  if (to.length === 0) return null;
  const headers = Array.isArray(body.Headers)
    ? (body.Headers as { Name?: string; Value?: string }[])
    : [];
  const header = (name: string) =>
    headers.find((entry) => entry.Name?.toLowerCase() === name.toLowerCase())?.Value ?? null;
  const text =
    typeof body.TextBody === "string" && body.TextBody.trim()
      ? body.TextBody
      : typeof body.HtmlBody === "string"
        ? htmlToText(body.HtmlBody)
        : "";
  const messageId =
    header("Message-ID") ?? (typeof body.MessageID === "string" ? `<${body.MessageID}>` : null);
  return {
    from: { email: fromEmail, name: String(fromFull?.Name ?? "").trim() },
    to,
    cc: addresses(body.CcFull, body.Cc),
    subject: String(body.Subject ?? "").trim(),
    text: text.trim(),
    messageId,
    inReplyTo: header("In-Reply-To"),
    attachments: Array.isArray(body.Attachments)
      ? (body.Attachments as { Name?: string; ContentType?: string; Content?: string }[])
          .filter((entry) => entry.Name && entry.Content)
          .map((entry) => ({
            name: entry.Name!,
            contentType: entry.ContentType ?? "application/octet-stream",
            base64: entry.Content!,
          }))
      : [],
  };
}

/** A teammate's address, like iris@team.example.com. */
export function emailAddress(slug: string, domain: string): string {
  return `${slug}@${domain}`;
}

/** The teammate an address is for: its handle, ignoring +tags. Null for other domains. */
export function recipientHandle(address: string, domain: string): string | null {
  const [local, host] = address.toLowerCase().split("@");
  if (!local || host !== domain.toLowerCase()) return null;
  return local.split("+")[0] || null;
}

/** "Re: Hello" for a reply, without piling up prefixes. */
export function replySubject(subject: string): string {
  return /^re:/i.test(subject.trim()) ? subject.trim() : `Re: ${subject.trim()}`;
}
