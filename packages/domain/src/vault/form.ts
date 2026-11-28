import { cardDigits, type VaultKind } from "./vault";

/**
 * The form that adds or edits a login or card, shared by the web's dialog and the phone's editor
 * so their rules and wording can't drift apart. Secrets are never sent back, so an edit starts
 * with every secret field empty, and an empty one keeps what's saved.
 */

/** What the form shows of an item: never its secret. */
export interface VaultFormItem {
  kind: VaultKind;
  name: string;
  domain: string | null;
  /** The username, or "Visa •••• 4242". */
  hint: string;
  teammateIds: string[] | null;
}

export interface VaultForm {
  name: string;
  /** The login's site. */
  domain: string;
  username: string;
  password: string;
  number: string;
  expiry: string;
  cvc: string;
  /** The name on the card. */
  holder: string;
  zip: string;
  /** The teammates that may use it, or null for every teammate. */
  teammateIds: string[] | null;
}

/** The fields that hold a secret, which an edit starts empty (the username is shown, so it isn't). */
export const VAULT_SECRET_FORM_FIELDS = [
  "password",
  "number",
  "expiry",
  "cvc",
  "holder",
  "zip",
] as const satisfies readonly (keyof VaultForm)[];

export const VAULT_NAME_MAX = 80;

/** The form for an item as it's saved, or a blank one to add. */
export function vaultForm(item: VaultFormItem | null): VaultForm {
  return {
    name: item?.name ?? "",
    domain: item?.domain ?? "",
    username: item?.kind === "login" ? item.hint : "",
    password: "",
    number: "",
    expiry: "",
    cvc: "",
    holder: "",
    zip: "",
    teammateIds: item ? item.teammateIds : null,
  };
}

/** The same form with every secret field emptied: what typing a secret leaves once it's dropped. */
export function withoutSecrets(form: VaultForm): VaultForm {
  const next = { ...form };
  for (const field of VAULT_SECRET_FORM_FIELDS) next[field] = "";
  return next;
}

/** Whether any secret was typed into the form. */
export const hasTypedSecret = (form: VaultForm) =>
  VAULT_SECRET_FORM_FIELDS.some((field) => form[field] !== "");

/** "4242 4242 4242 4242", grouped as the card prints it, while you type. */
export function groupCardNumber(value: string): string {
  const digits = cardDigits(value).replace(/\D/g, "").slice(0, 19);
  const groups = /^3[47]/.test(digits) ? [4, 6, 5] : [4, 4, 4, 4, 3];
  const parts: string[] = [];
  let offset = 0;
  for (const size of groups) {
    if (offset >= digits.length) break;
    parts.push(digits.slice(offset, offset + size));
    offset += size;
  }
  return parts.join(" ");
}

/** "08/29" while you type "0829": the slash goes in after the month. */
export function expiryInput(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 4);
  return digits.length > 2 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits;
}

/** The security code as you type it: up to four digits. */
export const cvcInput = (value: string) => value.replace(/\D/g, "").slice(0, 4);

const sameAccess = (a: string[] | null, b: string[] | null) =>
  a === null || b === null
    ? a === b
    : a.length === b.length && [...a].sort().join() === [...b].sort().join();

type FormField = keyof VaultForm;

/** Each field that differs between where the form started and what it says now. */
function changedFields(start: VaultForm, form: VaultForm): FormField[] {
  return (Object.keys(start) as FormField[]).filter((field) =>
    field === "teammateIds"
      ? !sameAccess(start.teammateIds, form.teammateIds)
      : field === "name" || field === "domain" || field === "username"
        ? start[field].trim() !== form[field].trim()
        : start[field] !== form[field],
  );
}

export const vaultFormChanged = (start: VaultForm, form: VaultForm) =>
  changedFields(start, form).length > 0;

/** The form and where it started: an edit sends only the difference from it. */
export interface VaultDraft {
  start: VaultForm;
  form: VaultForm;
}

/**
 * A fresher copy of the item (it changed on the web, say): what you haven't touched follows it, and
 * what you changed stays yours. Secrets aren't sent back, so they're never "fresher".
 */
export function rebaseVaultForm(draft: VaultDraft, fresh: VaultForm): VaultDraft {
  if (!vaultFormChanged(draft.start, fresh)) return draft;
  const touched = changedFields(draft.start, draft.form);
  const form = { ...fresh };
  for (const field of touched) (form as Record<FormField, unknown>)[field] = draft.form[field];
  return { start: fresh, form };
}

/**
 * Why the form can't be saved yet, or null when it can. These are the gaps the form can see;
 * the worker checks the rest (a card number's checksum, the site) and says so in its own words.
 */
export function vaultFormProblem(kind: VaultKind, form: VaultForm, editing: boolean) {
  if (!form.name.trim()) return "Give it a name.";
  if (form.teammateIds !== null && form.teammateIds.length === 0)
    return "Pick at least one teammate, or everyone.";
  if (kind === "login") {
    if (!form.domain.trim()) return "Give the site it's for, like github.com.";
    if (!form.username.trim()) return "Add the username or email.";
    if (!editing && !form.password) return "Add the password.";
    return null;
  }
  if (editing) return null;
  if (!form.number) return "Add the card number.";
  if (!form.expiry) return "Give the expiry date as MM/YY.";
  if (!form.cvc) return "Add the security code.";
  if (!form.holder.trim()) return "Add the name on the card.";
  return null;
}

/** The secret's fields to send, as the API names them; empty ones keep what's saved when editing. */
export function vaultSecretInput(kind: VaultKind, form: VaultForm): Record<string, string> {
  return kind === "login"
    ? { username: form.username, password: form.password }
    : { number: form.number, expiry: form.expiry, cvc: form.cvc, name: form.holder, zip: form.zip };
}

/** A change to a saved item: only what differs from where the form started. */
export interface VaultChange {
  name?: string;
  domain?: string;
  teammateIds?: string[] | null;
  secret?: Record<string, string>;
}

/**
 * What an edit sends (`vault.patch`): the fields you changed and the secrets you typed, so an edit
 * made elsewhere meanwhile to anything else stays. Null when nothing changed.
 */
export function vaultChange(
  kind: VaultKind,
  start: VaultForm,
  form: VaultForm,
): VaultChange | null {
  const changed = new Set(changedFields(start, form));
  const change: VaultChange = {};
  if (changed.has("name")) change.name = form.name.trim();
  if (kind === "login" && changed.has("domain")) change.domain = form.domain.trim();
  if (changed.has("teammateIds")) change.teammateIds = form.teammateIds;
  const secret: Record<string, string> = {};
  if (kind === "login") {
    if (changed.has("username")) secret.username = form.username.trim();
    if (form.password) secret.password = form.password;
  } else {
    const typed = vaultSecretInput(kind, form);
    for (const [field, value] of Object.entries(typed)) if (value.trim()) secret[field] = value;
  }
  if (Object.keys(secret).length > 0) change.secret = secret;
  return Object.keys(change).length > 0 ? change : null;
}

/** Who may use an item, in a few words, and the teammates to show beside them. */
export function vaultAccess<T extends { id: string; name: string }>(
  teammateIds: string[] | null,
  teammates: readonly T[],
): { text: string; teammates: T[] } {
  if (teammateIds === null) return { text: "Every teammate", teammates: [] };
  const picked = teammateIds
    .map((id) => teammates.find((teammate) => teammate.id === id))
    .filter((teammate) => teammate !== undefined);
  if (picked.length === 0) return { text: "No current teammate", teammates: [] };
  return {
    text: picked.length === 1 ? `Only ${picked[0]!.name}` : `${picked.length} teammates`,
    teammates: picked,
  };
}

/** Whether a teammate may use an item. */
export const mayUse = (item: { teammateIds: string[] | null }, teammateId: string) =>
  item.teammateIds === null || item.teammateIds.includes(teammateId);

/** What deleting an item asks first. */
export function deleteVaultItemQuestion(item: { kind: VaultKind; name: string }) {
  return {
    title: `Delete ${item.name}?`,
    body: `Teammates can't use it anymore. ${item.kind === "card" ? "Past purchases stay in their history. " : ""}This can't be undone.`,
    action: "Delete",
  };
}

/** The words the vault's screens share on the web and the phone. */
export const VAULT_COPY = {
  loginsAbout: "Sign-ins teammates fill in on the right site.",
  cardsAbout: "For purchases within each teammate's monthly budget.",
  noLogins: "No logins yet. Save one, and teammates sign in on that site without asking you.",
  noCards: "No cards yet. Save one, and give a teammate a budget to buy things for you.",
  loginDialog:
    "Teammates type it in for you on this site, and only on this site. They never see the password.",
  cardDialog:
    "Teammates fill it in at checkout, only for purchases within their budget. They never see the number.",
  savedPlaceholder: "Saved. Type to replace it.",
  savedToast: "Teammates fill it in on the computer without seeing it.",
  everyone: "Every teammate can use it",
  everyoneHint: "Including teammates you add later.",
  siteHint: "It also works on its subdomains.",
  screenshots:
    "A page can still show what was typed, like a card number at checkout, in the screenshots a teammate takes. For a sign-in that needs a code from your phone, the teammate asks you to take over.",
} as const;

/** How the vault keeps what you save safe, as both apps list it. */
export const VAULT_PROMISES = [
  {
    key: "never-seen",
    title: "Never seen",
    text: "Teammates type it on the computer's screen without it ever passing through them or the chat.",
  },
  {
    key: "own-site",
    title: "Only on its site",
    text: "A login fills only when the browser shows its site, so a look-alike page can't collect it.",
  },
  {
    key: "budget",
    title: "Within a budget",
    text: "A card works only for a purchase within the teammate's monthly budget, and larger ones ask you.",
  },
  {
    key: "encrypted",
    title: "Encrypted",
    text: "Stored encrypted, and never sent back to this app. Editing replaces what's saved.",
  },
] as const;

export const addVaultItemLabel = (kind: VaultKind) => (kind === "login" ? "Add login" : "Add card");

export const vaultEditorTitle = (kind: VaultKind, editing: string | null) =>
  editing !== null ? `Edit ${editing}` : kind === "login" ? "Add a login" : "Add a card";

export const vaultSaveLabel = (kind: VaultKind, editing: boolean) =>
  editing ? "Save" : kind === "login" ? "Save login" : "Save card";

export const vaultSavedTitle = (kind: VaultKind, editing: boolean) =>
  editing ? "Saved" : kind === "login" ? "Login saved" : "Card saved";
