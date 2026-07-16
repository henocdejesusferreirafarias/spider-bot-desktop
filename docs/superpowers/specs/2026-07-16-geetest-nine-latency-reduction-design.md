# GeeTest Nine Latency Reduction Design

## Context

The automatic GeeTest solver currently gives each rejected `nine` answer a fresh budget of ten `/load` requests. With five answer attempts, one captcha can therefore issue as many as fifty `/load` requests before falling back to manual solving. The model is not the bottleneck: local measurements put a warmed nine-match inference at roughly 45-59 ms.

The current path also inserts 180 ms between every unsuccessful search request, waits up to 2.5 seconds for the page bridge, waits another fixed 1.2 seconds after success, and downloads the grid and prompt sequentially.

## Goals

- Preserve two independent limits: ten non-nine/error rerolls and five answered `nine` challenges.
- Bound one automatic solve to at most fifteen `/load` requests instead of fifty.
- Avoid artificial delay after a valid non-nine response.
- Keep a short delay after transport errors and rejected `nine` answers.
- Return promptly once the captcha actually disappears.
- Preserve the shared single-concurrency ONNX inference queue.
- Keep the existing 60-second overall deadline and manual fallback.

## Non-goals

- Changing the nine-match model, preprocessing, threshold, or ranking behavior.
- Restoring support for `icon`, `slide`, or the legacy Python solver.
- Increasing inference concurrency.
- Changing the manual captcha workflow.

## Design

### Global retry accounting

The runtime will maintain two counters for one automatic solve:

- `rerollAttempts`: incremented for each non-nine response, malformed response, or `/load` error; maximum 10.
- `answerAttempts`: incremented when a usable `nine` challenge is selected for the solve pipeline; maximum 5. Download, inference, signing, and verification failures consume that attempt.

Finding a usable `nine` challenge does not consume the reroll budget. A rejected answer starts another search while retaining both counters. Therefore the maximum is ten discarded/error loads plus five usable-nine loads, for fifteen `/load` calls total.

The 60-second deadline remains authoritative. Reaching either the reroll limit, answer limit, or deadline moves immediately to the existing manual fallback.

### Delay policy

- A valid non-nine response is rerolled immediately.
- A malformed response or `/load` error waits 180 ms before retrying.
- A rejected `nine` answer waits 180 ms before requesting another challenge.
- No delay is added after the final failed attempt.

This retains modest backoff for failures while removing pacing that only made successful network exchanges slower.

### Successful completion

The existing page bridge remains responsible for injecting verified GeeTest tokens. After the bridge reports success, the runtime will poll the existing captcha detector and return as soon as the challenge disappears, with a maximum settle window of 1.2 seconds. This replaces the unconditional 1.2-second sleep.

### Image fetching

`generateNineW` will fetch the grid and prompt concurrently with `Promise.all`, then run the existing batched nine-cell inference unchanged.

### Error visibility

Errors thrown while downloading images, running inference, signing, or verifying will be logged with their actual message and treated as a failed answer attempt. A genuine GeeTest rejection will continue to use the rejection message. This prevents operational failures from being silently mislabeled as model mistakes.

## Testing

- A runtime test will simulate ten non-nine responses and five rejected `nine` answers, asserting no more than fifteen loads and correct independent counters.
- A timing-policy test will assert that valid non-nine responses do not invoke the delay callback, while load errors do.
- A success-settle test will assert that the runtime returns as soon as the captcha detector becomes inactive rather than always consuming 1.2 seconds.
- A signer test will assert that grid and prompt fetches begin before either is allowed to finish.
- An error-reporting test will distinguish thrown solver errors from rejected verify responses.
- Run `npm run check` and `npm test` as final gates.

## Expected Outcome

A first-try `nine` still performs one `/load`, two parallel image downloads, one batched ONNX inference, and one `/verify`, without unnecessary retry delays. Mixed `icon`/`nine` sequences retain bounded rerolling, while the worst-case request count drops from fifty to fifteen.
