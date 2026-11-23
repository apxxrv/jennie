#!/usr/bin/env bash
# One-command AWS hosting for Countersign: one EC2 server behind CloudFront with a password gate, deleting itself at DEADLINE.
# Safe to re-run after a partial failure: every step finds what already exists. Reads secrets from the repo-root .env and sends
# them to SSM through boto3 (never on a command line). Prints the site address at the end, never a secret.
#
#   deploy/aws/deploy.sh
#
# Needs: the AWS CLI with a working SSO session for PROFILE, node + npm, and backend/.venv (for boto3).
set -euo pipefail

PROFILE="${PROFILE:-sandbox2025}"
REGION="us-east-1"
DEADLINE_ISO="2026-11-23T08:00:00Z"   # 1:00 am MST
DEADLINE_SYSTEMD="2026-11-23 08:00:00 UTC"
NAME="jennie-countersign"
PARAM="/jennie/env"
BUNDLE_KEY="bundle/countersign.tar.gz"
FUNCTION_NAME="jennie-basic-auth"
TAG_SPEC="Key=Project,Value=jennie"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$ROOT/deploy/aws"
GEN="$HERE/.generated"
PY="$ROOT/backend/.venv/bin/python"
cd "$ROOT"
mkdir -p "$GEN"
chmod 700 "$GEN"

unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_CREDENTIAL_EXPIRATION
export AWS_PROFILE="$PROFILE" AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION" AWS_PAGER=""

log() { printf '\n== %s\n' "$*"; }

# ---------------------------------------------------------------- 0. preflight
DEADLINE_EPOCH="$("$PY" "$HERE/helpers.py" deadline-epoch "$DEADLINE_ISO")"
NOW="$(date -u +%s)"
if [ "$NOW" -ge "$DEADLINE_EPOCH" ]; then
  echo "Refusing: the self-delete time $DEADLINE_ISO has passed. Change DEADLINE_ISO and DEADLINE_SYSTEMD in deploy.sh first." >&2
  exit 1
fi
echo "server deletes itself at $DEADLINE_ISO ($(( (DEADLINE_EPOCH - NOW) / 60 )) minutes from now)"
[ -f "$ROOT/.env" ] || { echo "missing $ROOT/.env" >&2; exit 1; }
if ! aws sts get-caller-identity --query Arn --output text >/dev/null 2>&1; then
  echo "AWS session for profile $PROFILE is not valid. Run: aws sso login --profile $PROFILE" >&2
  exit 1
fi
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"   # used in ARNs only, never printed
SUFFIX="$(printf '%s' "$ACCOUNT" | shasum -a 256 | cut -c1-10)"
BUCKET="$NAME-$SUFFIX"

# ---------------------------------------------------------------- 1. frontend build (same origin, live API)
log "building the frontend"
(cd frontend && npm ci --no-audit --no-fund --loglevel=error && VITE_API_URL="" VITE_USE_MOCKS=false npm run build)
if grep -rq "localhost:8000" frontend/dist; then
  echo "the built frontend still points at localhost:8000" >&2
  exit 1
fi

# ---------------------------------------------------------------- 2. code bundle in a private bucket
log "bundle and bucket"
if ! aws s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1; then
  aws s3api create-bucket --bucket "$BUCKET" >/dev/null
fi
aws s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-tagging --bucket "$BUCKET" --tagging "TagSet=[{$TAG_SPEC}]"
TAR="$GEN/countersign.tar"
git archive --format=tar -o "$TAR" HEAD
COPYFILE_DISABLE=1 tar --no-xattrs -rf "$TAR" frontend/dist
gzip -f "$TAR"
aws s3 cp "$TAR.gz" "s3://$BUCKET/$BUNDLE_KEY" --only-show-errors
echo "uploaded bundle of commit $(git rev-parse --short HEAD) plus frontend/dist"

# ---------------------------------------------------------------- 3. instance role
log "instance role"
ROLE="$NAME-ec2"
if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE" --tags "$TAG_SPEC" \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  NEW_ROLE=1
fi
aws iam attach-role-policy --role-name "$ROLE" --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
cat > "$GEN/role-policy.json" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {"Sid": "Claude", "Effect": "Allow", "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"], "Resource": "*"},
    {"Sid": "Voice", "Effect": "Allow", "Action": "polly:SynthesizeSpeech", "Resource": "*"},
    {"Sid": "Bundle", "Effect": "Allow", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::$BUCKET/$BUNDLE_KEY"},
    {"Sid": "Settings", "Effect": "Allow", "Action": "ssm:GetParameter", "Resource": "arn:aws:ssm:$REGION:$ACCOUNT:parameter$PARAM"}
  ]
}
JSON
aws iam put-role-policy --role-name "$ROLE" --policy-name countersign-app --policy-document "file://$GEN/role-policy.json"
if ! aws iam get-instance-profile --instance-profile-name "$ROLE" >/dev/null 2>&1; then
  aws iam create-instance-profile --instance-profile-name "$ROLE" --tags "$TAG_SPEC" >/dev/null
  NEW_ROLE=1
fi
if [ "$(aws iam get-instance-profile --instance-profile-name "$ROLE" --query 'length(InstanceProfile.Roles)' --output text)" = "0" ]; then
  aws iam add-role-to-instance-profile --instance-profile-name "$ROLE" --role-name "$ROLE"
  NEW_ROLE=1
fi
if [ "${NEW_ROLE:-0}" = "1" ]; then
  echo "waiting 15 s for the new role to reach EC2"
  sleep 15
fi

# ---------------------------------------------------------------- 4. security group: port 80 from CloudFront only
log "security group"
VPC="$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)"
SG="$(aws ec2 describe-security-groups --filters Name=group-name,Values="$NAME-origin" Name=vpc-id,Values="$VPC" --query 'SecurityGroups[0].GroupId' --output text)"
if [ "$SG" = "None" ]; then
  SG="$(aws ec2 create-security-group --group-name "$NAME-origin" --vpc-id "$VPC" \
    --description "Countersign origin: HTTP from CloudFront only" \
    --tag-specifications "ResourceType=security-group,Tags=[{$TAG_SPEC},{Key=Name,Value=$NAME-origin}]" --query GroupId --output text)"
fi
PL="$(aws ec2 describe-managed-prefix-lists --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing --query 'PrefixLists[0].PrefixListId' --output text)"
if [ "$(aws ec2 describe-security-group-rules --filters Name=group-id,Values="$SG" --query "length(SecurityGroupRules[?IsEgress==\`false\` && PrefixListId=='$PL'])" --output text)" = "0" ]; then
  aws ec2 authorize-security-group-ingress --group-id "$SG" \
    --ip-permissions "IpProtocol=tcp,FromPort=80,ToPort=80,PrefixListIds=[{PrefixListId=$PL,Description=CloudFront origin-facing}]" \
    --tag-specifications "ResourceType=security-group-rule,Tags=[{$TAG_SPEC}]" >/dev/null
fi

# ---------------------------------------------------------------- 5. the server
log "instance"
INSTANCE="$(aws ec2 describe-instances --filters Name=tag:Name,Values="$NAME" Name=tag:Project,Values=jennie \
  Name=instance-state-name,Values=pending,running,stopping,stopped --query 'Reservations[].Instances[0].InstanceId | [0]' --output text)"
if [ "$INSTANCE" = "None" ]; then
  AMI="$(aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 --query Parameter.Value --output text)"
  AZS="$(aws ec2 describe-instance-type-offerings --location-type availability-zone --filters Name=instance-type,Values=t3.small --query 'InstanceTypeOfferings[].Location' --output text | tr '\t' ',')"
  SUBNET="$(aws ec2 describe-subnets --filters Name=vpc-id,Values="$VPC" Name=default-for-az,Values=true Name=availability-zone,Values="$AZS" --query 'Subnets[0].SubnetId' --output text)"
  sed -e "s|__REGION__|$REGION|" -e "s|__BUCKET__|$BUCKET|" -e "s|__BUNDLE_KEY__|$BUNDLE_KEY|" -e "s|__PARAM__|$PARAM|" \
      -e "s|__DEADLINE__|$DEADLINE_SYSTEMD|" -e "s|__DEADLINE_EPOCH__|$DEADLINE_EPOCH|" "$HERE/bootstrap.sh" > "$GEN/user-data.sh"
  if grep -q "__[A-Z_]*__" "$GEN/user-data.sh"; then echo "unfilled placeholder in user-data" >&2; exit 1; fi
  INSTANCE="$(aws ec2 run-instances --image-id "$AMI" --instance-type t3.small --subnet-id "$SUBNET" --security-group-ids "$SG" \
    --iam-instance-profile Name="$ROLE" --instance-initiated-shutdown-behavior terminate \
    --metadata-options HttpTokens=required,HttpEndpoint=enabled \
    --block-device-mappings 'DeviceName=/dev/xvda,Ebs={VolumeSize=20,VolumeType=gp3,DeleteOnTermination=true,Encrypted=true}' \
    --user-data "file://$GEN/user-data.sh" \
    --tag-specifications "ResourceType=instance,Tags=[{$TAG_SPEC},{Key=Name,Value=$NAME}]" "ResourceType=volume,Tags=[{$TAG_SPEC},{Key=Name,Value=$NAME}]" \
    --query 'Instances[0].InstanceId' --output text)"
  echo "launched $INSTANCE"
  FRESH=1
fi
aws ec2 wait instance-running --instance-ids "$INSTANCE"
ORIGIN_DNS="$(aws ec2 describe-instances --instance-ids "$INSTANCE" --query 'Reservations[0].Instances[0].PublicDnsName' --output text)"
echo "instance $INSTANCE at $ORIGIN_DNS"

# ---------------------------------------------------------------- 6. password gate (CloudFront Function)
log "password gate"
"$PY" "$HERE/helpers.py" password "$HERE/.site-password"
"$PY" "$HERE/helpers.py" gate "$HERE/gate.template.js" "$HERE/.site-password" "$GEN/gate.js"
if aws cloudfront describe-function --name "$FUNCTION_NAME" >/dev/null 2>&1; then
  ETAG="$(aws cloudfront describe-function --name "$FUNCTION_NAME" --query ETag --output text)"
  aws cloudfront update-function --name "$FUNCTION_NAME" --if-match "$ETAG" \
    --function-config Comment="Countersign basic auth",Runtime=cloudfront-js-2.0 --function-code "fileb://$GEN/gate.js" >/dev/null
else
  aws cloudfront create-function --name "$FUNCTION_NAME" \
    --function-config Comment="Countersign basic auth",Runtime=cloudfront-js-2.0 --function-code "fileb://$GEN/gate.js" >/dev/null
fi
ETAG="$(aws cloudfront describe-function --name "$FUNCTION_NAME" --query ETag --output text)"
aws cloudfront publish-function --name "$FUNCTION_NAME" --if-match "$ETAG" >/dev/null
FUNCTION_ARN="$(aws cloudfront describe-function --name "$FUNCTION_NAME" --stage LIVE --query FunctionSummary.FunctionMetadata.FunctionARN --output text)"

# ---------------------------------------------------------------- 7. CloudFront distribution
log "CloudFront"
DIST="$(aws cloudfront list-distributions --query "DistributionList.Items[?Comment=='$NAME'].Id | [0]" --output text)"
if [ "$DIST" = "None" ] || [ -z "$DIST" ]; then
  "$PY" "$HERE/helpers.py" dist-config "$ORIGIN_DNS" "$FUNCTION_ARN" "$NAME" > "$GEN/dist.json"
  DIST="$(aws cloudfront create-distribution-with-tags --distribution-config-with-tags "file://$GEN/dist.json" --query Distribution.Id --output text)"
  echo "created distribution $DIST"
else
  aws cloudfront get-distribution-config --id "$DIST" > "$GEN/dist-current.json"
  CURRENT_ORIGIN="$("$PY" -c 'import json,sys; print(json.load(open(sys.argv[1]))["DistributionConfig"]["Origins"]["Items"][0]["DomainName"])' "$GEN/dist-current.json")"
  if [ "$CURRENT_ORIGIN" != "$ORIGIN_DNS" ]; then
    "$PY" "$HERE/helpers.py" dist-update "$GEN/dist-current.json" "$ORIGIN_DNS" > "$GEN/dist-update.json"
    ETAG="$("$PY" -c 'import json,sys; print(json.load(open(sys.argv[1]))["ETag"])' "$GEN/dist-current.json")"
    aws cloudfront update-distribution --id "$DIST" --if-match "$ETAG" --distribution-config "file://$GEN/dist-update.json" >/dev/null
    echo "pointed distribution $DIST at the new instance"
  fi
fi
DOMAIN="$(aws cloudfront get-distribution --id "$DIST" --query Distribution.DomainName --output text)"
SITE="https://$DOMAIN"

# ---------------------------------------------------------------- 8. server settings (secrets) into SSM
log "settings"
"$PY" "$HERE/helpers.py" env "$ROOT/.env" "$PARAM" "$SITE"

# ---------------------------------------------------------------- 9. ship code to an instance that was already running
if [ "${FRESH:-0}" != "1" ]; then
  log "re-running the bootstrap on $INSTANCE (new code and settings)"
  CMD="$(aws ssm send-command --instance-ids "$INSTANCE" --document-name AWS-RunShellScript \
    --parameters 'commands=["/usr/local/sbin/countersign-bootstrap"],executionTimeout=["1800"]' --query Command.CommandId --output text)"
  # The SSM waiter gives up after about 100 s; a bootstrap that reinstalls packages takes longer, so poll up to 30 minutes.
  STATUS="Pending"
  for _ in $(seq 1 180); do
    sleep 10
    STATUS="$(aws ssm get-command-invocation --command-id "$CMD" --instance-id "$INSTANCE" --query Status --output text 2>/dev/null || echo Pending)"
    case "$STATUS" in Pending|InProgress|Delayed) ;; *) break ;; esac
  done
  echo "bootstrap status: $STATUS"
  if [ "$STATUS" != "Success" ]; then
    echo "the bootstrap did not succeed; see /var/log/countersign-bootstrap.log on $INSTANCE through SSM" >&2
    exit 1
  fi
fi

# ---------------------------------------------------------------- 10. wait until the site answers
log "waiting for CloudFront to deploy (usually 3 to 10 minutes)"
aws cloudfront wait distribution-deployed --id "$DIST"
log "waiting for the backend (first boot installs packages: about 5 minutes)"
for _ in $(seq 1 90); do
  if curl -fsS --max-time 10 "$SITE/api/health" >/dev/null 2>&1; then
    log "site is up: $SITE"
    echo "login: user jennie, password in deploy/aws/.site-password"
    echo "self-delete: $DEADLINE_ISO. Remove the rest with deploy/aws/teardown.sh"
    exit 0
  fi
  sleep 10
done
echo "site did not answer /api/health within 15 minutes; check /var/log/countersign-bootstrap.log on $INSTANCE through SSM" >&2
exit 1
