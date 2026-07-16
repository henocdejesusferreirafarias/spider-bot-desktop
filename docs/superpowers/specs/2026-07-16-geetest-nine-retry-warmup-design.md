# GeeTest nine challenge selection, answer retries, and model warm-up

Date: 2026-07-16
Status: design approved, awaiting user spec review before implementation plan

## Context

The automatic GeeTest path currently solves only challenges whose captured
`risk_type` is `nine`. An explicitly different type, such as `icon`, is rejected
before any `/load` request. Challenges with no captured type are probed, and the
runtime currently makes up to five broad solve attempts.

The production platforms can alternate between `icon` and `nine`. The current
temporary policy is to solve only `nine`, but a non-`nine` challenge should not
immediately force manual intervention when the same GeeTest `captcha_id` can
issue a fresh challenge. Separately, a rejected model answer should permit a
bounded number of new `nine` attempts.

The `nine_match.onnx` session is also lazy. Although the model is small, its
first captcha pays session creation cost. The runtime should start that work as
soon as an automation run has Captcha Killer enabled.

## Goals

1. Try up to 10 `/load` requests to obtain a `captcha_type=nine` challenge,
   including when the captured `risk_type` is explicitly different.
2. Retry after at most 5 rejected `nine` answers.
3. Keep challenge-selection attempts and rejected-answer attempts as separate
   counters.
4. Fall back to the existing manual captcha flow when either limit or a
   60-second total deadline is reached.
5. Warm the singleton ONNX session in the background when an enabled automation
   run starts.

## Non-goals

- Solving `icon`, `slide`, or any other GeeTest type.
- Restoring the legacy Python solver as a fallback.
- Changing the trained model, its preprocessing, or its inference queue.
- Refreshing or clicking the visible GeeTest widget in order to reroll it.
- Changing the manual captcha experience after automatic solving gives up.

## Terminology

- **Captured risk type:** the `risk_type` observed in the page's GeeTest network
  request. It is a hint about the visible challenge, not a reason to skip the
  new selection loop.
- **Loaded captcha type:** the `captcha_type` returned by GeeTest `/load`. Only
  a returned value of `nine`, compared case-insensitively, is eligible for the
  TypeScript solver.
- **Search attempt:** one `/load` call made while looking for an eligible
  `nine` challenge.
- **Answer attempt:** one eligible `nine` challenge that reaches model
  inference and `/verify`.
- **Rejected answer:** an answer attempt whose verification does not return a
  complete successful seccode, including `lot_number` and `pass_token`.

## Retry model

The limits are independent and nested:

```text
deadline = now + 60 seconds

for answerAttempt = 1..5:
  nineChallenge = null

  for searchAttempt = 1..10:
    stop and use manual flow if deadline expired
    data = GET /load with risk_type=nine
    if data.captcha_type is nine:
      nineChallenge = data
      break
    wait 180 ms before another search

  if no nineChallenge:
    use manual flow

  run nine model, sign, and verify nineChallenge
  if verification succeeds:
    apply the solution to the page and finish
  if verification rejects the answer:
    wait 180 ms and begin a fresh 10-search round

use manual flow after the fifth rejected answer
```

The `/load` request explicitly sends `risk_type=nine`, even when page capture
reported another type. The returned `captcha_type` remains authoritative; the
solver must never treat a non-`nine` response as `nine` merely because that type
was requested.

The 10-attempt search budget resets only after a `nine` challenge was found and
its answer was rejected. Receiving a non-`nine` response consumes a search
attempt but does not consume an answer attempt.

The maximum normal path is therefore 50 `/load` calls and 5 model submissions.
The 60-second deadline is authoritative and may end the loops earlier. It
includes request time, image downloads, inference, signing, verification, and
retry delays.

## Failure classification

| Failure | Counter and behavior |
|---|---|
| `/load` returns non-`nine` | Consume one search attempt. |
| `/load` throws or returns malformed data | Consume one search attempt and continue after the retry delay. |
| Ten searches produce no usable `nine` | Stop automatic solving and use manual flow. |
| Model, image, signing, or `/verify` operation fails after a `nine` was selected | Consume one answer attempt so operational failures remain bounded. |
| `/verify` returns no valid pass token | Consume one answer attempt and start a new search round. |
| Five answer attempts fail | Stop automatic solving and use manual flow. |
| Total elapsed time reaches 60 seconds | Stop immediately and use manual flow. |
| GeeTest verifies successfully but the page callback cannot be applied | Preserve the existing solution-injection fallback, then use manual flow; do not spend another model answer on an integration failure. |
| Automation is cancelled | Abort through the existing run-active checks. |

The runtime logs the final reason and the counters reached, without logging
challenge payloads, model inputs, or verification secrets.

## Components

### `NineChallengeSelector`

A small helper owns the search loop independently from model inference. Its
interface accepts a GeeTest client, `captchaId`, search limit, deadline, and
retry callback. It returns either the loaded `nine` challenge plus the number
of searches used, or a typed failure reason.

This boundary keeps type selection testable without ONNX, browser pages, or
real network calls.

### `solveNineGeetestWithClient`

The existing solver function should accept an already loaded `nine` challenge
or be split so loading and solving are distinct operations. It must not perform
another hidden `/load`, because the selector owns and counts every challenge
load.

It continues to use the TypeScript signer and `NineMatchClassifier`; no Python
worker or legacy icon classifier is involved.

### Automation runtime

`tryAutoSolveGeetestCaptcha` owns the outer answer loop and the 60-second
deadline. It no longer rejects an explicitly non-`nine` captured risk type.
For each answer attempt it calls the selector, solves the selected challenge,
and classifies the result as success, rejection, or operational failure.

Returning `false` preserves the existing behavior in
`waitForManualCaptchaIfPresent`: remove the automatic-solving mask, bring the
browser forward, log a warning, and wait for manual completion.

### ONNX warm-up

`NineMatchClassifier` exposes a warm-up operation that initializes its ONNX
session without running fake inference. Session initialization is represented
by one shared promise, so concurrent warm-up and first-use calls cannot create
duplicate sessions.

When initialization rejects, the shared promise is cleared after logging the
failure. A later real inference may retry initialization. The automation run is
not blocked or failed solely because background warm-up failed.

The runtime starts warm-up when it initializes an automation run whose
`autoCaptchaSolverEnabled` parameter is true. The call is fire-and-forget with
handled rejection. All windows and runs still share the existing main-process
classifier singleton and inference queue.

## Observability

Automatic solving logs concise progress at meaningful boundaries:

- warm-up failure, if any;
- no `nine` after 10 searches;
- rejected `nine` answer number `N/5`;
- success with answer and search counts;
- 60-second deadline reached;
- transition to manual solving.

Per-request logging is avoided so the normal fast path remains quiet.

## Tests

Unit tests use fake GeeTest clients and fake timers or injected clocks where
needed. Required cases:

1. An explicitly captured `icon` type enters selection instead of being skipped.
2. Selection requests `risk_type=nine` and accepts only a returned
   `captcha_type=nine`.
3. Nine non-`nine` responses followed by `nine` use 10 searches and one answer.
4. Ten non-`nine` responses fall back to manual without running inference.
5. A rejected answer starts a fresh search budget.
6. Five rejected answers stop after five model submissions.
7. Non-`nine` loads never consume the answer counter.
8. Success stops both loops immediately.
9. The 60-second deadline stops either loop.
10. Concurrent warm-up and first inference create one ONNX session.
11. A failed warm-up does not permanently prevent a later initialization retry.

Existing queue and batch-inference tests remain unchanged. Final verification
is `npm run check` followed by `npm test`.

## Acceptance criteria

1. Any detected GeeTest can enter the automatic selection flow while Captcha
   Killer is enabled, regardless of captured `risk_type`.
2. At most 10 loads are used in one search round.
3. At most 5 `nine` challenges reach inference and verification.
4. Search and answer counters behave independently.
5. Automatic work lasts no more than 60 seconds before manual fallback, subject
   only to cancellation semantics and the request layer's ability to abort an
   in-flight request.
6. The old Python solver is not invoked.
7. Enabling Captcha Killer starts exactly one shared ONNX session warm-up.
8. Existing manual fallback and inference serialization continue to work.
9. `npm run check` and `npm test` pass.

## Expected files

| File | Expected action |
|---|---|
| `src/main/services/captcha/onnx-session.ts` | Add idempotent, retryable warm-up support. |
| `src/main/services/geetest-solver.ts` | Separate challenge selection from solve/verify and expose bounded helpers. |
| `src/main/services/automation-runtime.ts` | Run warm-up, nested retry budgets, deadline, logging, and manual fallback. |
| `test/captcha-photo-classifier.test.ts` | Cover singleton session initialization behavior. |
| `test/geetest-solver.test.ts` | Cover selection and retry semantics. |
| `test/automation-runtime.test.ts` or the nearest existing runtime test | Cover integration with captured non-`nine` and manual fallback where practical. |

No model assets, training scripts, datasets, Python worker files, ADRs, or
unrelated runtime services are changed by this feature.
