import { describe, expect, it } from "vitest";
import {
  cvcInput,
  deleteVaultItemQuestion,
  expiryInput,
  groupCardNumber,
  hasTypedSecret,
  rebaseVaultForm,
  vaultAccess,
  vaultChange,
  vaultCreate,
  vaultForm,
  vaultFormChanged,
  vaultFormProblem,
  withoutSecrets,
  type VaultFormItem,
} from "./form";

const login: VaultFormItem = {
  kind: "login",
  name: "GitHub",
  domain: "github.com",
  hint: "octo@example.com",
  teammateIds: null,
};
const card: VaultFormItem = {
  kind: "card",
  name: "Visa",
  domain: null,
  hint: "Visa •••• 4242",
  teammateIds: ["a"],
};

describe("vaultForm", () => {
  it("starts an edit from what's saved, with every secret empty", () => {
    expect(vaultForm(login)).toMatchObject({
      name: "GitHub",
      domain: "github.com",
      username: "octo@example.com",
      password: "",
      teammateIds: null,
    });
    expect(vaultForm(card)).toMatchObject({ username: "", number: "", teammateIds: ["a"] });
    expect(vaultForm(null)).toMatchObject({ name: "", teammateIds: null });
  });

  it("drops typed secrets and keeps the rest", () => {
    const typed = { ...vaultForm(card), number: "4242", cvc: "123", holder: "Test", name: "New" };
    expect(hasTypedSecret(typed)).toBe(true);
    const dropped = withoutSecrets(typed);
    expect(dropped).toMatchObject({ number: "", cvc: "", holder: "", name: "New" });
    expect(hasTypedSecret(dropped)).toBe(false);
  });
});

describe("typing", () => {
  it("groups a card number as it's printed", () => {
    expect(groupCardNumber("4242424242424242")).toBe("4242 4242 4242 4242");
    expect(groupCardNumber("378282246310005")).toBe("3782 822463 10005");
    expect(groupCardNumber("42-42 x4")).toBe("4242 4");
  });

  it("puts the expiry's slash in and keeps the security code to digits", () => {
    expect(expiryInput("0829")).toBe("08/29");
    expect(expiryInput("08")).toBe("08");
    expect(expiryInput("08/2")).toBe("08/2");
    expect(cvcInput("12a345")).toBe("1234");
  });
});

describe("vaultFormProblem", () => {
  it("asks for what a new login or card needs", () => {
    const blank = vaultForm(null);
    expect(vaultFormProblem("login", blank, false)).toBe("Give it a name.");
    const named = { ...blank, name: "GitHub", domain: "github.com", username: "octo" };
    expect(vaultFormProblem("login", named, false)).toBe("Add the password.");
    expect(vaultFormProblem("login", { ...named, password: "pw" }, false)).toBeNull();
    expect(vaultFormProblem("card", { ...blank, name: "Visa" }, false)).toBe(
      "Add the card number.",
    );
    expect(vaultFormProblem("login", { ...named, password: "pw", teammateIds: [] }, false)).toBe(
      "Pick at least one teammate, or everyone.",
    );
  });

  it("lets an edit keep the saved secrets", () => {
    expect(vaultFormProblem("login", vaultForm(login), true)).toBeNull();
    expect(vaultFormProblem("card", vaultForm(card), true)).toBeNull();
    expect(vaultFormProblem("login", { ...vaultForm(login), username: " " }, true)).toBe(
      "Add the username or email.",
    );
  });
});

describe("vaultChange", () => {
  it("sends only what changed, and the secrets typed", () => {
    const start = vaultForm(login);
    expect(vaultChange("login", start, start)).toBeNull();
    expect(vaultChange("login", start, { ...start, name: "GitHub work " })).toEqual({
      name: "GitHub work",
    });
    expect(vaultChange("login", start, { ...start, password: "new pw" })).toEqual({
      secret: { password: "new pw" },
    });
    expect(
      vaultChange("login", start, { ...start, username: "hub", teammateIds: ["b", "a"] }),
    ).toEqual({ teammateIds: ["b", "a"], secret: { username: "hub" } });
  });

  it("treats the same teammates in another order as unchanged", () => {
    const start = { ...vaultForm(login), teammateIds: ["a", "b"] };
    expect(vaultChange("login", start, { ...start, teammateIds: ["b", "a"] })).toBeNull();
  });

  it("sends a card's typed fields under the API's names, and never its site", () => {
    const start = vaultForm(card);
    expect(
      vaultChange("card", start, { ...start, cvc: "999", holder: "Test Owner", domain: "x.com" }),
    ).toEqual({ secret: { cvc: "999", name: "Test Owner" } });
  });
});

describe("vaultCreate", () => {
  it("sends a new item under a fresh id, and a lost one again exactly", () => {
    let made = 0;
    const newId = () => `id-${++made}`;
    const form = {
      ...vaultForm(null),
      name: " GitHub ",
      domain: "github.com",
      username: "octo",
      password: "made-up-pass",
    };
    const first = vaultCreate(null, "login", form, newId);
    expect(first).toEqual({
      id: "id-1",
      kind: "login",
      name: "GitHub",
      domain: "github.com",
      teammateIds: null,
      secret: { username: "octo", password: "made-up-pass" },
    });
    // Its answer never came: Try again sends the same item under the same id.
    expect(vaultCreate(first, "login", { ...form, name: "Changed" }, newId)).toBe(first);
    expect(made).toBe(1);
    // A card has no site.
    expect(vaultCreate(null, "card", { ...form, domain: "shop.com" }, newId)).toMatchObject({
      id: "id-2",
      domain: "",
    });
  });
});

describe("rebaseVaultForm", () => {
  it("follows what changed elsewhere for the fields you haven't touched", () => {
    const start = vaultForm(login);
    const draft = { start, form: { ...start, password: "typed", domain: "gitlab.com" } };
    const fresh = vaultForm({ ...login, name: "GitHub (web)", domain: "github.dev" });
    const rebased = rebaseVaultForm(draft, fresh);
    expect(rebased.start).toBe(fresh);
    expect(rebased.form).toMatchObject({
      name: "GitHub (web)",
      domain: "gitlab.com",
      password: "typed",
    });
    expect(vaultChange("login", rebased.start, rebased.form)).toEqual({
      domain: "gitlab.com",
      secret: { password: "typed" },
    });
  });

  it("keeps the same draft when nothing changed elsewhere", () => {
    const start = vaultForm(login);
    const draft = { start, form: { ...start, name: "Mine" } };
    expect(rebaseVaultForm(draft, vaultForm(login))).toBe(draft);
    expect(vaultFormChanged(draft.start, draft.form)).toBe(true);
  });
});

describe("vaultAccess", () => {
  const teammates = [
    { id: "a", name: "Ava" },
    { id: "b", name: "Ben" },
  ];
  it("says who may use it", () => {
    expect(vaultAccess(null, teammates).text).toBe("Every teammate");
    expect(vaultAccess(["a"], teammates).text).toBe("Only Ava");
    expect(vaultAccess(["a", "b"], teammates).text).toBe("2 teammates");
    expect(vaultAccess(["gone"], teammates)).toEqual({
      text: "No current teammate",
      teammates: [],
    });
  });
});

describe("deleteVaultItemQuestion", () => {
  it("says a card's purchases stay", () => {
    expect(deleteVaultItemQuestion(card).body).toBe(
      "Teammates can't use it anymore. Past purchases stay in their history. This can't be undone.",
    );
    expect(deleteVaultItemQuestion(login)).toMatchObject({
      title: "Delete GitHub?",
      body: "Teammates can't use it anymore. This can't be undone.",
    });
  });
});
