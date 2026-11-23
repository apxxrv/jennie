"""Small helpers for deploy.sh. Secrets are read from files and sent to AWS through boto3, never through a command line.

  helpers.py deadline-epoch "2026-11-23T08:00:00Z"        prints the Unix time
  helpers.py password FILE                                  makes the site password once (mode 600), prints nothing
  helpers.py gate TEMPLATE PASSWORD_FILE OUT                writes the CloudFront Function with the credential filled in
  helpers.py env LOCAL_ENV PARAM SITE_URL                   builds the server .env and stores it as one SecureString
  helpers.py dist-config ORIGIN_DNS FUNCTION_ARN COMMENT    prints a CloudFront DistributionConfigWithTags as JSON
  helpers.py dist-update CONFIG_JSON_FILE ORIGIN_DNS        rewrites the origin in a get-distribution-config result, prints it
"""

from __future__ import annotations

import base64
import json
import os
import secrets
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

SITE_USER = "jennie"
ORIGIN_ID = "countersign-ec2"
CACHING_DISABLED = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"  # managed cache policy CachingDisabled
ALL_VIEWER = "216adef6-5c7f-47e4-b989-5492eafa07d3"  # managed origin request policy AllViewer

# Settings that differ on the server. Everything else is copied from the laptop .env unchanged.
SERVER_OVERRIDES: dict[str, str] = {
    "AWS_PROFILE": "",
    "AWS_REGION": "us-east-1",
    "APP_ENV": "production",
    "MCP_READ_TOKEN": "",
    "BOUNTY_WEBHOOK_SECRET": "",
    "DATABASE_URL": "sqlite:///./countersign.db",
}


def deadline_epoch(iso: str) -> int:
    return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(timezone.utc).timestamp())


def ensure_password(path: Path) -> None:
    if path.exists() and len(path.read_text().strip()) >= 20:
        return
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(secrets.token_urlsafe(18) + "\n")  # 24 characters


def write_gate(template: Path, password_file: Path, out: Path) -> None:
    password = password_file.read_text().strip()
    token = base64.b64encode(f"{SITE_USER}:{password}".encode()).decode()
    code = template.read_text()
    if "__EXPECTED_AUTH_B64__" not in code:
        raise SystemExit("gate template has no placeholder")
    fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(code.replace("__EXPECTED_AUTH_B64__", token))


def server_env(local_env: Path, site_url: str) -> str:
    overrides = dict(SERVER_OVERRIDES, PUBLIC_BASE_URL=site_url, FRONTEND_URL=site_url)
    seen: set[str] = set()
    out: list[str] = ["# Built by deploy/aws/deploy.sh from the laptop .env. Lives in SSM Parameter Store; do not edit on the server."]
    for line in local_env.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith("#"):  # comments stay on the laptop; keeps the parameter small
            continue
        key = line.split("=", 1)[0].strip()
        if key.startswith("VITE_"):
            continue
        if key in overrides:
            out.append(f"{key}={overrides[key]}")
            seen.add(key)
        else:
            out.append(line)
    out += [f"{k}={v}" for k, v in overrides.items() if k not in seen]
    return "\n".join(out) + "\n"


def put_env(local_env: Path, param: str, site_url: str) -> None:
    import boto3

    value = server_env(local_env, site_url)
    ssm = boto3.client("ssm")
    tier = "Advanced" if len(value.encode()) > 4096 else "Standard"
    ssm.put_parameter(Name=param, Value=value, Type="SecureString", Overwrite=True, Tier=tier)
    ssm.add_tags_to_resource(ResourceType="Parameter", ResourceId=param, Tags=[{"Key": "Project", "Value": "jennie"}])
    print(f"stored {param} ({tier}, {len(value.splitlines())} lines)")


def _origin(dns: str) -> dict:
    return {
        "Id": ORIGIN_ID,
        "DomainName": dns,
        "OriginPath": "",
        "CustomHeaders": {"Quantity": 0},
        "CustomOriginConfig": {
            "HTTPPort": 80,
            "HTTPSPort": 443,
            "OriginProtocolPolicy": "http-only",
            "OriginSslProtocols": {"Quantity": 1, "Items": ["TLSv1.2"]},
            "OriginReadTimeout": 60,
            "OriginKeepaliveTimeout": 5,
        },
        "ConnectionAttempts": 3,
        "ConnectionTimeout": 10,
    }


def dist_config(origin_dns: str, function_arn: str, comment: str) -> dict:
    methods = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    config = {
        "CallerReference": f"{comment}-{int(time.time())}",
        "Comment": comment,
        "Enabled": True,
        "PriceClass": "PriceClass_100",
        "HttpVersion": "http2",
        "IsIPV6Enabled": True,
        "Origins": {"Quantity": 1, "Items": [_origin(origin_dns)]},
        "DefaultCacheBehavior": {
            "TargetOriginId": ORIGIN_ID,
            "ViewerProtocolPolicy": "redirect-to-https",
            "AllowedMethods": {"Quantity": 7, "Items": methods, "CachedMethods": {"Quantity": 2, "Items": ["GET", "HEAD"]}},
            "Compress": True,
            "CachePolicyId": CACHING_DISABLED,
            "OriginRequestPolicyId": ALL_VIEWER,
            "FunctionAssociations": {"Quantity": 1, "Items": [{"EventType": "viewer-request", "FunctionARN": function_arn}]},
        },
        "ViewerCertificate": {"CloudFrontDefaultCertificate": True},
    }
    return {"DistributionConfig": config, "Tags": {"Items": [{"Key": "Project", "Value": "jennie"}]}}


def dist_update(config_file: Path, origin_dns: str) -> dict:
    """Takes `aws cloudfront get-distribution-config` output, returns the DistributionConfig with the new origin."""
    config = json.loads(config_file.read_text())["DistributionConfig"]
    for item in config["Origins"]["Items"]:
        if item["Id"] == ORIGIN_ID:
            item["DomainName"] = origin_dns
    return config


def main(argv: list[str]) -> None:
    cmd, args = argv[1], argv[2:]
    if cmd == "deadline-epoch":
        print(deadline_epoch(args[0]))
    elif cmd == "password":
        ensure_password(Path(args[0]))
    elif cmd == "gate":
        write_gate(Path(args[0]), Path(args[1]), Path(args[2]))
    elif cmd == "env":
        put_env(Path(args[0]), args[1], args[2])
    elif cmd == "dist-config":
        print(json.dumps(dist_config(args[0], args[1], args[2])))
    elif cmd == "dist-update":
        print(json.dumps(dist_update(Path(args[0]), args[1])))
    else:
        raise SystemExit(f"unknown command {cmd}")


if __name__ == "__main__":
    main(sys.argv)
