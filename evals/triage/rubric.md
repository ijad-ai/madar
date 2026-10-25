# Triage label rubric (v1)

Label the **primary cause**: the thing a fix should target to make this failure go away. Work through the questions in order and stop at the first "yes".

## Decision order

1. **Product bug.** Does the application behave wrongly against its requirements, a reasonable user expectation, or its previous correct behavior?
2. **Environment.** Is the cause outside both the app's logic and the test code: an unreachable service or identity provider, DNS, a CI runner out of resources, a missing browser binary, an expired certificate, a blocked network domain, a staging deploy in progress?
3. **Test data.** Is a data precondition missing or wrong: an expired or locked test account, a seed record consumed by an earlier run, a feature flag set differently for that tenant, a date that has rolled past?
4. **Locator drift.** Does the app behave correctly, but the test's selector no longer finds the intended element (renamed test id, changed copy, restructured DOM)?
5. **Flaky test.** Is the cause nondeterminism in the test itself: a race, a missing `await`, a fixed `waitForTimeout`, order dependence between tests, shared state, an assertion on timing?

Flaky test comes last on purpose. It's the label people reach for too early, and calling a real product bug "flaky" is the costliest mistake this dataset exists to catch.

If none fits, don't force a label. Leave the failure out of the dataset and note why.

## The confusable pairs

| Pair                         | Ask                                                                                                 | Example                                                                                                                                     |
| ---------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Product bug vs locator drift | Is the intended element **missing because the feature broke**, or **present under a new selector**? | Button gone because the cart crashes: product bug. Button renamed from `apply-coupon` to `coupon-apply` and still works: locator drift.     |
| Flaky test vs environment    | Is the nondeterminism **in the test** or **in what the test depends on**?                           | Passes on retry because a missing `await` races the render: flaky test. Passes on retry after the identity provider recovered: environment. |
| Test data vs product bug     | Is the data **invalid for the test**, or does the app **mishandle valid data**?                     | Test account expired: test data. App rejects a valid postcode: product bug.                                                                 |
| Environment vs test data     | Is the **service** unavailable, or is the **record** wrong?                                         | Database unreachable: environment. Seed user deleted by another suite: test data.                                                           |

## Signals worth checking

- **Retry outcome.** Passing on retry points to flaky test or environment, never product bug alone.
- **Blast radius.** Many unrelated specs failing in one run points to environment.
- **The diff.** UI changes in the same release point to locator drift; logic changes point to product bug.
- **History.** The same spec failing intermittently for weeks points to flaky test.
- **Screenshot and trace.** Element present but not matched suggests locator drift; an error page suggests product bug or environment.

## Confidence

- **High:** evidence directly shows the cause (diff, error page, outage record).
- **Medium:** strong signals, but the cause isn't shown directly.
- **Low:** best guess. Low-confidence pairs that disagree go to adjudication like any other.

## Rationale

One or two sentences that name the evidence: "Test id renamed in the same release; screenshot shows the button present." Not: "Looks like locator drift."
