# Countersign on AWS (one server, one password, timed self-delete)

A short-lived hosted copy of the whole app for a demo night. One command builds it, one command removes it.

## What it creates

All in `us-east-1` (CloudFront is global), tagged `Project=jennie` where AWS allows tags.

- **EC2 instance** `jennie-countersign`: t3.small, Amazon Linux 2023, 20 GB gp3, no SSH key and no port 22 (use SSM). nginx on port 80 serves `frontend/dist` and proxies `/api/` and `/mcp` to uvicorn on 127.0.0.1:8000 (a systemd service that restarts on failure). SQLite, voice clips and caches live on the instance disk.
- **Security group** `jennie-countersign-origin`: port 80 from the CloudFront origin-facing prefix list only. Nothing else inbound.
- **IAM role and instance profile** `jennie-countersign-ec2`: SSM core, Bedrock invoke, Polly synthesize, read of the one S3 bundle, read of the one SSM parameter.
- **S3 bucket** `jennie-countersign-<hash>`: private, holds `bundle/countersign.tar.gz` (the committed tree from `git archive HEAD` plus the built `frontend/dist`).
- **SSM parameter** `/jennie/env`: SecureString with the server `.env`, built from the laptop `.env` (blank `AWS_PROFILE`, `APP_ENV=production`, CloudFront address as `PUBLIC_BASE_URL` and `FRONTEND_URL`, MCP and bounty secrets blank, `VITE_*` dropped).
- **CloudFront Function** `jennie-basic-auth` (no tags; CloudFront Functions do not support them): HTTP Basic auth, user `jennie`, password in `deploy/aws/.site-password`. Twilio's own routes stay open because Twilio cannot log in and each carries a per-call secret: `/api/voice/audio/<hash>.wav`, `/api/voice/twiml/<id>`, `/api/voice/gather/<id>`, `/api/webhooks/twilio/status[...]`, plus `/api/health`.
- **CloudFront distribution** (comment `jennie-countersign`): `*.cloudfront.net` certificate, HTTP redirects to HTTPS, caching off, all headers, cookies and query strings forwarded, 60 s origin read timeout.

## Deploy

```sh
deploy/aws/deploy.sh
```

Needs an AWS SSO session for `sandbox2025` (`aws sso login --profile sandbox2025`), node and npm, and `backend/.venv`. It builds the frontend with relative API URLs, uploads the bundle, creates or reuses each resource, stores the settings, and waits until `/api/health` answers through CloudFront. First run takes about 10 to 15 minutes, mostly CloudFront and pip. Re-running is safe: it reuses what exists and, on a running server, re-runs the bootstrap to ship new code and settings (the database is kept). It refuses to run after the self-delete time.

## Self-delete

The instance shuts down at **2026-11-23 08:00 UTC** (1:00 am MST) from a systemd timer (`countersign-selfdestruct.timer`, survives reboots) and was launched with shutdown behavior `terminate`, so shutdown deletes it and its disk. Everything else stays until teardown. To move the time, change `DEADLINE_ISO` and `DEADLINE_SYSTEMD` in `deploy.sh` and launch a new instance.

## Tear down

```sh
deploy/aws/teardown.sh
```

Deletes the instance, distribution, function, security group, profile and role, bucket and parameter. CloudFront has to be disabled and finish deploying before it can be deleted, so the script waits (often 5 to 15 minutes). If it times out or is stopped, run it again.

## Cost drivers

- EC2 t3.small: about $0.02 per hour while it runs.
- EBS 20 GB gp3: about $0.002 per hour, gone with the instance.
- CloudFront: per request and per GB out; a demo night is cents.
- Bedrock and Polly: per use, the same as running from the laptop (a cold payment run calls Claude for every invoice).
- S3, SSM Standard parameter, CloudFront Function: effectively free at this size.

## Known limits

- One server, one process, SQLite on its disk: no redundancy. If the instance dies the data is gone.
- The site is protected by one shared password. Anyone with it has the full app, including attacks that ring real phones.
- Twilio's routes are open at the gate; the app's per-call tokens are what protect them.
- `/api/voice/smoke-twiml` and the browser vendor phone (`/api/voice/vendor-phone/...`) are behind the password.
- The origin uses the EC2 public DNS name over plain HTTP; the security group allows only CloudFront to reach it.
- After the instance self-deletes, CloudFront answers 502 until teardown.
