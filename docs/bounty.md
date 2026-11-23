# Rob Jenny bounty inbox

Source: `backend/app/services/bounty.py`. Provider: Postmark inbound email, or Amazon SES through SNS (see [SES inbound](#ses-inbound)).

## Setup

1. In Postmark, set the inbound webhook URL of the inbound stream to `https://anything:<BOUNTY_WEBHOOK_SECRET>@<backend host>/api/bounty/inbound`. Postmark does not sign inbound mail; it sends the URL's credentials as HTTP Basic auth, and the password is the secret. (`x-webhook-secret: <secret>` also works, for a forwarder or curl.)
2. Set `BOUNTY_WEBHOOK_SECRET` (the inbox is closed with a 503 while it is blank). Set `BOUNTY_MODERATOR_TOKEN`: the queue and moderation routes need it as the header `x-moderator-token`, and they answer 503 while it is blank once the secret is set. `BOUNTY_GLOBAL_LIMIT_PER_HOUR` (default 60) caps accepted submissions per hour across all senders.
3. Do not advertise the address until the organizers have said yes (#ask-directors).

## `POST /api/bounty/inbound`

| Rule | Behavior |
|---|---|
| No or wrong secret | 401, nothing read, nothing stored |
| Global cap | `BOUNTY_GLOBAL_LIMIT_PER_HOUR` (60) accepted per hour across all senders, then 429 with `Retry-After` |
| Rate limit | 5 accepted per sender per hour, else 429 with `Retry-After`. `+tags` and Gmail dots count as the same sender |
| Size | request at most 8 MB (413); email text at most 50 KB (413) |
| Attachments | PDF only, judged by content type and the `%PDF-` bytes (415); each at most 5 MB, at most 3 (413). One bad file rejects the email |
| Redelivery | Postmark retries; a `MessageID` already accepted answers `200 {"duplicate": true}` and creates nothing |

An accepted email becomes a message in a **new thread** (the sender never joins a vendor's thread), an invoice, an `attacks` row (`source: bounty_email`, `moderation_status: pending`) and a mini-run through the same extraction, injection scan, risk assessment, verification call and payment steps as every other invoice. A vendor named in the email is only a hint and is stored as `vendor_claim: {verified: false}`. Money can only go to the vendor's verified account (Nessie sandbox), a changed account triggers a call to a number from `ALLOWED_CALL_NUMBERS`, and nothing in the email can change either.

Response: `{attack_id, message_id, invoice_id, run_id, queued, ...}`.

## SES inbound

`POST /api/bounty/inbound/ses` is the same inbox fed by Amazon SES instead of Postmark. It takes the same secret, then turns the email into the same fields and runs every rule in the table above (limits, PDF only, sizes, duplicates). SNS retries a failed delivery; the SES `messageId` is the duplicate key.

1. Verify the domain in SES and point its MX record at `inbound-smtp.<region>.amazonaws.com`.
2. Create an SNS topic.
3. Add an SES receipt rule for the bounty address with an SNS action to that topic (encoding UTF-8 or Base64; both work).
4. Subscribe the HTTPS endpoint `https://anything:<BOUNTY_WEBHOOK_SECRET>@<backend host>/api/bounty/inbound/ses` to the topic. The route confirms the subscription itself, but only by fetching an `https://sns.<region>.amazonaws.com` URL.
5. Set `SES_INBOUND_TOPIC_ARN` to the topic's ARN: messages from any other topic get 403.

Limits:
- The SES SNS action only delivers emails up to 150 KB in total, so an email with a large PDF bounces. Bigger mail would need an S3 action instead, which this route does not read.
- SNS message signatures are not verified; the secret and the topic check are the only auth. Verify the signature before relying on this in production.

## Leaderboard and moderation

- Until a moderator approves it, the row on `GET /api/attacks/leaderboard` has only the masked handle, the card, the result and the time. Outcome, reasons, amounts and the attack text appear after approval. The sender's address is never shown in full.
- `GET /api/bounty/queue?status=pending|approved|hidden|all` lists submissions oldest first, with the attack text for the moderator (untrusted: render as text).
- `POST /api/bounty/{attack_id}/moderate` with `{action: "approve" | "hide", moderator}`. Audited as a human action; emits `attack.logged` with the new `moderation_status`.
