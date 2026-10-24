import { describe, expect, it } from "vitest";
import { applyBlockedMessage, blockedApplication } from "./apply-guard";

describe("blockedApplication", () => {
  it("blocks submissions that mention apply on the portals", () => {
    expect(
      blockedApplication(
        "https://www.linkedin.com/voyager/api/voyagerJobsDashOnsiteApplyApplication?action=submitApplication",
        "POST",
      ),
    ).toMatchObject({ label: "LinkedIn" });
    expect(
      blockedApplication(
        "https://www.naukri.com/cloudgateway-apply/apply-services/v1/apply",
        "post",
      ),
    ).toMatchObject({ label: "Naukri" });
    expect(
      blockedApplication("https://in.linkedin.com/jobs/easyApply/submit", "PUT"),
    ).not.toBeNull();
  });

  it("lets reading through, and leaves other sites alone", () => {
    expect(
      blockedApplication("https://www.linkedin.com/jobs/view/4012345678/?apply=1", "GET"),
    ).toBeNull();
    expect(blockedApplication("https://www.linkedin.com/voyager/api/feed", "POST")).toBeNull();
    expect(blockedApplication("https://boards.greenhouse.io/acme/jobs/1/apply", "POST")).toBeNull();
    expect(blockedApplication("https://notlinkedin.com/apply", "POST")).toBeNull();
    expect(blockedApplication("not a url", "POST")).toBeNull();
  });

  it("covers extra domains, for testing against a stand-in portal", () => {
    expect(
      blockedApplication("http://host.docker.internal:4567/apply", "POST", [
        "host.docker.internal",
      ]),
    ).toMatchObject({
      domain: "host.docker.internal",
    });
  });

  it("tells the bot where it was stopped", () => {
    expect(applyBlockedMessage(["LinkedIn", "LinkedIn"])).toContain("on LinkedIn.");
  });
});
