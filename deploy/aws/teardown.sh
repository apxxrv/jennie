#!/usr/bin/env bash
# Deletes everything deploy.sh created: the instance, CloudFront distribution and function, security group, instance profile and
# role, S3 bucket and SSM parameter. CloudFront must be disabled and finish deploying (often 5 to 15 minutes) before it can be
# deleted; this script waits for that. If it is interrupted, run it again: every step skips what is already gone.
set -euo pipefail

PROFILE="${PROFILE:-sandbox2025}"
REGION="us-east-1"
NAME="jennie-countersign"
PARAM="/jennie/env"
FUNCTION_NAME="jennie-basic-auth"
ROLE="$NAME-ec2"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$ROOT/deploy/aws"
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_CREDENTIAL_EXPIRATION
export AWS_PROFILE="$PROFILE" AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION" AWS_PAGER=""

log() { printf '\n== %s\n' "$*"; }

if ! aws sts get-caller-identity --query Arn --output text >/dev/null 2>&1; then
  echo "AWS session for profile $PROFILE is not valid. Run: aws sso login --profile $PROFILE" >&2
  exit 1
fi
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
BUCKET="$NAME-$(printf '%s' "$ACCOUNT" | shasum -a 256 | cut -c1-10)"

log "instance"
INSTANCES="$(aws ec2 describe-instances --filters Name=tag:Project,Values=jennie Name=tag:Name,Values="$NAME" \
  Name=instance-state-name,Values=pending,running,stopping,stopped,shutting-down --query 'Reservations[].Instances[].InstanceId' --output text)"
if [ -n "$INSTANCES" ]; then
  # shellcheck disable=SC2086
  aws ec2 terminate-instances --instance-ids $INSTANCES >/dev/null
  # shellcheck disable=SC2086
  aws ec2 wait instance-terminated --instance-ids $INSTANCES
  echo "terminated $INSTANCES"
else
  echo "no instance left"
fi

log "CloudFront distribution"
DIST="$(aws cloudfront list-distributions --query "DistributionList.Items[?Comment=='$NAME'].Id | [0]" --output text)"
if [ "$DIST" != "None" ] && [ -n "$DIST" ]; then
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  aws cloudfront get-distribution-config --id "$DIST" > "$TMP/current.json"
  ENABLED="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["DistributionConfig"]["Enabled"])' "$TMP/current.json")"
  if [ "$ENABLED" = "True" ]; then
    python3 -c 'import json,sys; c=json.load(open(sys.argv[1]))["DistributionConfig"]; c["Enabled"]=False; print(json.dumps(c))' "$TMP/current.json" > "$TMP/disabled.json"
    ETAG="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["ETag"])' "$TMP/current.json")"
    aws cloudfront update-distribution --id "$DIST" --if-match "$ETAG" --distribution-config "file://$TMP/disabled.json" >/dev/null
    echo "disabled $DIST"
  fi
  echo "waiting for CloudFront to finish disabling (often 5 to 15 minutes; if this times out, run teardown.sh again)"
  aws cloudfront wait distribution-deployed --id "$DIST"
  ETAG="$(aws cloudfront get-distribution --id "$DIST" --query ETag --output text)"
  aws cloudfront delete-distribution --id "$DIST" --if-match "$ETAG"
  echo "deleted $DIST"
else
  echo "no distribution left"
fi

log "CloudFront function"
if aws cloudfront describe-function --name "$FUNCTION_NAME" >/dev/null 2>&1; then
  ETAG="$(aws cloudfront describe-function --name "$FUNCTION_NAME" --query ETag --output text)"
  aws cloudfront delete-function --name "$FUNCTION_NAME" --if-match "$ETAG"
  echo "deleted $FUNCTION_NAME"
else
  echo "no function left"
fi

log "security group"
VPC="$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)"
SG="$(aws ec2 describe-security-groups --filters Name=group-name,Values="$NAME-origin" Name=vpc-id,Values="$VPC" --query 'SecurityGroups[0].GroupId' --output text)"
if [ "$SG" != "None" ]; then
  aws ec2 delete-security-group --group-id "$SG"
  echo "deleted $SG"
else
  echo "no security group left"
fi

log "instance profile and role"
if aws iam get-instance-profile --instance-profile-name "$ROLE" >/dev/null 2>&1; then
  if [ "$(aws iam get-instance-profile --instance-profile-name "$ROLE" --query 'length(InstanceProfile.Roles)' --output text)" != "0" ]; then
    aws iam remove-role-from-instance-profile --instance-profile-name "$ROLE" --role-name "$ROLE"
  fi
  aws iam delete-instance-profile --instance-profile-name "$ROLE"
  echo "deleted instance profile $ROLE"
fi
if aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam detach-role-policy --role-name "$ROLE" --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore 2>/dev/null || true
  aws iam delete-role-policy --role-name "$ROLE" --policy-name countersign-app 2>/dev/null || true
  aws iam delete-role --role-name "$ROLE"
  echo "deleted role $ROLE"
fi

log "bucket and settings"
if aws s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1; then
  aws s3 rm "s3://$BUCKET" --recursive --only-show-errors
  aws s3api delete-bucket --bucket "$BUCKET"
  echo "deleted bucket $BUCKET"
fi
if aws ssm get-parameter --name "$PARAM" >/dev/null 2>&1; then
  aws ssm delete-parameter --name "$PARAM"
  echo "deleted parameter $PARAM"
fi

rm -rf "$HERE/.generated"
log "all gone (the site password file deploy/aws/.site-password is kept; delete it if you like)"
