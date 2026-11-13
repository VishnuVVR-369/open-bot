---
name: council
description: Trigger this if the user says 'council'.
---

# Council

Bring in two delegates to help with the user's request, usually for review
or feedback. Use one model from each of two different providers, at
high reasoning effort. If the user's instructions name council members, use
those. Otherwise pick the latest flagship model from each provider, for
example Claude Opus and GPT Sol.

In T3 Code, use `orchestrator_capabilities` to resolve the models, then
`delegate_task` to start one delegate per model in parallel. If you cannot reach two providers, or a named
member is unavailable, report it instead of substituting.

Give each delegate the request and relevant context. For review or feedback,
keep their work read-only. Collect their responses and summarize the useful
findings, disagreements, and recommended next steps.

For a code review or a design review, ask each delegate for a score out of 10.
Count each full review pass as one round.
A fresh review after fixes starts a new round.

If the work ends in a pull request, put the results in the PR description.
Put this section before the model and harness line at the end:

```markdown
## Council review

Rounds: 2

| Delegate    | Round 1 | Round 2 |
| ----------- | ------- | ------- |
| Claude Opus | 7/10    | 9/10    |
| GPT Sol     | 8/10    | 10/10   |
```

If a delegate gives no score, write `no score`. Do not invent one.
If the PR is open, edit the description. Do not post a comment for this.
If there is no PR, put the same results in the final reply only.

If you agree with their recommendations, make the changes and request a fresh
review after. Continue this process until all delegates are satisfied with the
outcome.

Do not let repeated reviews result in scope creep. It is your job to fight to
keep scope limited.

## Round rules

- Tie each round to one commit. For UI, send one screenshot set from that
  commit (see `openbot-ui-review`).
- Ask each delegate to list what it actually inspected. A review that could not
  load all evidence is incomplete, not a pass.
- Label every finding accepted, rejected (with reason), deferred, or fixed and
  verified. Findings outside the requested scope are deferred.
- If a delegate fails (for example a rate limit), report it and keep its
  partial findings. Do not silently drop it.
