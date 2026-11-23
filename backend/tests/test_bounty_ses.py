"""The bounty inbox fed by Amazon SES through an SNS HTTPS subscription: same secret, same rules as the Postmark route. No network."""

import base64
import json
from email.message import EmailMessage

import httpx
import pytest
from sqlmodel import Session, func, select

from app.config import Settings
from app.models import Attack, Message
from app.services import bounty as bounty_mod
from seed import seed as seedmod
from tests.test_attacks import SECRET, mail, wait
from tests.test_run import env  # noqa: F401  (env is a fixture: a private seeded database + client)

# not marked slow: the whole file runs in about 2 s
URL = "/api/bounty/inbound/ses"
TOPIC = "arn:aws:sns:us-east-1:123456789012:bounty-inbound"
H = {"x-webhook-secret": SECRET, "content-type": "text/plain; charset=UTF-8"}


def settings(topic=""):
    return Settings(bounty_webhook_secret=SECRET, bounty_moderator_token="mod-token", ses_inbound_topic_arn=topic)


@pytest.fixture()
def secret(monkeypatch):
    monkeypatch.setattr(bounty_mod, "get_settings", lambda: settings())
    return H


@pytest.fixture()
def fetched(monkeypatch):
    """Stub the confirmation GET: record the URLs, answer 200."""
    urls = []

    async def fake_get(self, url, **kw):
        urls.append(str(url))
        return httpx.Response(200, text="<ConfirmSubscriptionResponse/>")

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    return urls


def n_attacks(eng):
    with Session(eng) as s:
        return s.exec(select(func.count()).select_from(Attack)).one()


def confirmation(url="https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=x&Token=t", topic=TOPIC):
    return {"Type": "SubscriptionConfirmation", "MessageId": "m1", "Token": "t", "TopicArn": topic, "SubscribeURL": url, "Message": "You have chosen to subscribe"}


def mime(sender="hunter@example.com", attachments=(), message_id="<abc@example.com>") -> bytes:
    """The raw email, as the stdlib builds it from the same content as test_attacks.mail()."""
    m = mail(sender)
    e = EmailMessage()
    e["From"], e["To"], e["Subject"], e["Message-ID"] = m["From"], "rob@bounty.example", m["Subject"], message_id
    e.set_content(m["TextBody"])
    for raw, maintype, subtype, name in attachments:
        e.add_attachment(raw, maintype=maintype, subtype=subtype, filename=name)
    return bytes(e)


def notification(raw: bytes, ses_id="ses-0001", b64=False, topic=TOPIC):
    content = base64.b64encode(raw).decode() if b64 else raw.decode()
    note = {"notificationType": "Received", "mail": {"messageId": ses_id, "source": "hunter@example.com", "commonHeaders": {"subject": "x"}},
            "receipt": {"action": {"type": "SNS", "encoding": "BASE64" if b64 else "UTF8"}}, "content": content}
    return {"Type": "Notification", "MessageId": "n1", "TopicArn": topic, "Message": json.dumps(note)}


def post(client, body, headers=H):
    return client.post(URL, content=json.dumps(body).encode(), headers=headers)  # SNS sends JSON as text/plain


# ---------------------------------------------------------------- the secret


def test_no_or_wrong_secret_is_rejected_and_nothing_is_fetched_or_stored(env, secret, fetched):
    client, eng = env
    before = n_attacks(eng)
    for h in ({"content-type": "text/plain"}, {"x-webhook-secret": "wrong"},
              {"Authorization": "Basic " + base64.b64encode(b"sns:wrong").decode()}):
        assert post(client, confirmation(), h).status_code == 401
        assert post(client, notification(mime()), h).status_code == 401
    assert fetched == [] and n_attacks(eng) == before
    basic = {"Authorization": "Basic " + base64.b64encode(f"anything:{SECRET}".encode()).decode()}
    assert post(client, confirmation(), basic).status_code == 200  # the URL's credentials, as SNS sends them


def test_request_size_cap_applies(env, secret):
    client, _ = env
    assert client.post(URL, content=b"x" * (8 * 1024 * 1024 + 1), headers=H).status_code == 413


# ---------------------------------------------------------------- subscription confirmation


def test_a_valid_subscription_confirmation_is_fetched_once(env, secret, fetched):
    client, _ = env
    r = post(client, confirmation())
    assert r.status_code == 200 and r.json() == {"confirmed": True}
    assert fetched == [confirmation()["SubscribeURL"]]


@pytest.mark.parametrize("url", [
    "http://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription",
    "https://evil.example/?Action=ConfirmSubscription",
    "https://sns.us-east-1.amazonaws.com.evil.example/",
    "https://sns.us-east-1.amazonaws.com@evil.example/",
    "https://user:pw@sns.us-east-1.amazonaws.com/",
    "https://sns.us-east-1.amazonaws.com:8443/",
    "https://169.254.169.254/latest/meta-data/",
    "file:///etc/passwd",
    "",
])
def test_a_non_sns_subscribe_url_is_refused_and_nothing_is_fetched(env, secret, fetched, url):
    client, _ = env
    assert post(client, confirmation(url)).status_code == 400
    assert fetched == []


def test_a_wrong_topic_is_refused_when_the_topic_is_set(env, monkeypatch, fetched):
    client, eng = env
    monkeypatch.setattr(bounty_mod, "get_settings", lambda: settings(TOPIC))
    before = n_attacks(eng)
    assert post(client, confirmation(topic="arn:aws:sns:us-east-1:999999999999:other")).status_code == 403
    assert post(client, notification(mime(), topic="arn:aws:sns:us-east-1:999999999999:other")).status_code == 403
    assert fetched == [] and n_attacks(eng) == before
    assert post(client, confirmation()).status_code == 200 and len(fetched) == 1  # the configured topic is fine


def test_an_unsubscribe_confirmation_does_nothing(env, secret, fetched):
    client, eng = env
    before = n_attacks(eng)
    assert post(client, {**confirmation(), "Type": "UnsubscribeConfirmation"}).status_code == 200
    assert fetched == [] and n_attacks(eng) == before


# ---------------------------------------------------------------- notifications


def test_a_plain_text_email_creates_an_attack_like_the_postmark_route(env, secret):
    client, eng = env
    r = post(client, notification(mime()))
    assert r.status_code == 200, r.text
    body = r.json()
    wait(client, body["run_id"])
    with Session(eng) as s:
        atk = s.get(Attack, body["attack_id"])
        msg = s.get(Message, body["message_id"])
        assert atk.source.value == "bounty_email" and atk.moderation_status.value == "pending" and atk.attacker_name == "hunter@example.com"
        assert atk.detail_json["vendor_claim"] == {"vendor_id": "ven_summit", "verified": False}
        assert atk.detail_json["subject"] == "Invoice from Summit Concrete" and "Hunter Bank" in atk.detail_json["body"]
        assert msg.thread_id.startswith("thr_") and msg.thread_id != "thr_summit_0919"


def test_a_base64_email_with_a_pdf_is_accepted(env, secret):
    client, eng = env
    pdf = (seedmod.PDF_DIR / "poisoned_white_text.pdf").read_bytes()
    r = post(client, notification(mime("pdf@example.com", [(pdf, "application", "pdf", "invoice.pdf")]), ses_id="ses-pdf", b64=True))
    assert r.status_code == 200, r.text
    wait(client, r.json()["run_id"])
    with Session(eng) as s:
        assert s.get(Attack, r.json()["attack_id"]).detail_json.get("has_pdf") is True


def test_a_non_pdf_attachment_gets_the_same_status_as_postmark(env, secret):
    client, eng = env
    before = n_attacks(eng)
    pm = client.post("/api/bounty/inbound", json={**mail("txt1@example.com"), "Attachments": [
        {"Name": "n.txt", "ContentType": "text/plain", "Content": base64.b64encode(b"hello").decode()}]}, headers={"x-webhook-secret": SECRET})
    ses = post(client, notification(mime("txt2@example.com", [(b"hello", "text", "plain", "n.txt")])))
    assert pm.status_code == ses.status_code == 415
    assert n_attacks(eng) == before


def test_the_same_ses_message_id_twice_is_a_duplicate(env, secret):
    client, eng = env
    first = post(client, notification(mime("dup@example.com"), ses_id="ses-dup-1")).json()
    again = post(client, notification(mime("dup@example.com"), ses_id="ses-dup-1"))
    assert again.status_code == 200 and again.json() == {"duplicate": True, "attack_id": first["attack_id"]}
    assert n_attacks(eng) == 1


@pytest.mark.parametrize("message", [
    "not json",
    json.dumps(["a list"]),
    json.dumps({"notificationType": "Bounce", "content": "x"}),
    json.dumps({"notificationType": "Received", "mail": {"messageId": "x"}}),  # S3 action: no content
    None,
])
def test_malformed_message_gets_422(env, secret, message):
    client, eng = env
    assert post(client, {"Type": "Notification", "TopicArn": TOPIC, "Message": message}).status_code == 422
    assert n_attacks(eng) == 0


def test_malformed_mime_and_bodies_are_4xx_never_500(env, secret):
    client, eng = env
    for content in ("\x00\x01\x02 garbage", "From: <<<@@@>>>\r\nSubject: \udcff\r\n\r\nhi", "Content-Type: multipart/mixed; boundary=\"\r\n\r\n--",
                    "From: a@example.com\r\nContent-Type: text/plain; charset=no-such-charset\r\n\r\nhi"):
        note = {"notificationType": "Received", "mail": {"messageId": "bad"}, "content": content}
        r = post(client, {"Type": "Notification", "TopicArn": TOPIC, "Message": json.dumps(note)})
        assert 400 <= r.status_code < 500, (content, r.status_code, r.text)
    assert client.post(URL, content=b"not json", headers=H).status_code == 422
    assert post(client, {"Type": "Something"}).status_code == 422
