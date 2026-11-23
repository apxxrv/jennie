// CloudFront Function (viewer-request, cloudfront-js-2.0): HTTP Basic auth in front of the whole site.
// deploy.sh replaces the placeholder below with base64("user:password") and uploads the result; the filled-in copy is
// git-ignored. Credentials are compared here and never logged.
//
// Open without a login, because Twilio cannot log in (each of these carries its own per-call secret, checked by the app):
//   /api/voice/audio/<sha256>.wav          clips Twilio plays
//   /api/voice/twiml/<call_id>             the call's TwiML
//   /api/voice/gather/<call_id>            the caller's answer
//   /api/webhooks/twilio/status[/<id>/<t>] call status callbacks
//   /api/health                            uptime check, shows only mock flags
// The patterns are exact, so a path like /api/voice/audio/../attacks can never slip through to another route.

var EXPECTED = "__EXPECTED_AUTH_B64__";

var OPEN = [
  /^\/api\/health$/,
  /^\/api\/voice\/audio\/[0-9a-f]{64}\.wav$/,
  /^\/api\/voice\/(twiml|gather)\/[A-Za-z0-9_-]{1,64}$/,
  /^\/api\/webhooks\/twilio\/status(\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,128})?$/,
];

function same(a, b) {
  // Length-independent loop so the time taken does not reveal how much of the password matched.
  var diff = a.length ^ b.length;
  for (var i = 0; i < b.length; i++) {
    diff |= (a.charCodeAt(i % (a.length || 1)) || 0) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function handler(event) {
  var request = event.request;
  for (var i = 0; i < OPEN.length; i++) {
    if (OPEN[i].test(request.uri)) {
      return request;
    }
  }
  var header = request.headers.authorization;
  if (header && header.value.length > 6 && header.value.slice(0, 6).toLowerCase() === "basic " && same(header.value.slice(6).trim(), EXPECTED)) {
    return request;
  }
  return {
    statusCode: 401,
    statusDescription: "Unauthorized",
    headers: {
      "www-authenticate": { value: 'Basic realm="Countersign", charset="UTF-8"' },
      "cache-control": { value: "no-store" },
    },
  };
}
