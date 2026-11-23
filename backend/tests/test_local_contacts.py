"""CONTACTS_PROVIDER=local: the Actor's crawler runs inside the backend. The Actor's own HTML fixtures are served through an httpx
mock transport (two fake hosts, no network), and the other host must never receive a request."""

import asyncio
from pathlib import Path

import httpx
import pytest

from app.config import get_settings
from app.models import Vendor
from app.services import contacts
from app.services.vendor_contact import verify_business

FIXTURES = Path(__file__).resolve().parents[2] / "apify" / "vendor-contact-verifier" / "tests" / "fixtures"
SITE = "http://site.test"
OTHER = "http://other.test"


class FakeWeb:
    """site.test serves the fixtures folder, other.test serves fixtures/other_host. Every requested URL is recorded."""

    def __init__(self) -> None:
        self.hits: list[str] = []
        self.transport = httpx.MockTransport(self.handle)

    def handle(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        self.hits.append(url)
        root = {"site.test": FIXTURES, "other.test": FIXTURES / "other_host"}.get(request.url.host)
        if root is None:
            return httpx.Response(404, headers={"Content-Type": "text/html"}, text="<html><body>Not found</body></html>")
        target = root / request.url.path.lstrip("/")
        if target.is_dir():
            target = target / "index.html"
        redirect = Path(str(target) + ".302")
        if redirect.is_file():
            return httpx.Response(302, headers={"Location": self.fill(redirect.read_text())})
        if not target.is_file() or root.resolve() not in target.resolve().parents:
            return httpx.Response(404, headers={"Content-Type": "text/html"}, text="<html><body>Not found</body></html>")
        ctype = "text/plain" if target.suffix == ".txt" else "text/html; charset=utf-8"
        return httpx.Response(200, headers={"Content-Type": ctype}, content=self.fill(target.read_text()).encode())

    @staticmethod
    def fill(text: str) -> str:
        return text.replace("{{OTHER_ORIGIN}}", OTHER).replace("{{SITE_ORIGIN}}", SITE)

    def other_hits(self) -> list[str]:
        return [h for h in self.hits if not h.startswith(SITE + "/")]


@pytest.fixture()
def web() -> FakeWeb:
    return FakeWeb()


@pytest.fixture(autouse=True)
def clean(monkeypatch, tmp_path):
    contacts.health.reset()
    monkeypatch.setattr(get_settings(), "contacts_cache_dir", str(tmp_path / "cc"))
    yield
    contacts.health.reset()


def run(coro):
    return asyncio.run(coro)


def vendor(folder: str) -> Vendor:
    return Vendor(id=f"ven_{folder}", name="Vendor", trade="supply", email_domain="vendor.example", website_url=f"{SITE}/{folder}/")


def check(web: FakeWeb, folder: str) -> dict:
    return run(verify_business("Vendor", f"{SITE}/{folder}/", transport=web.transport))


# ---------------------------------------------------------------- verify_business: the Actor's row


def test_consistent_site_gives_one_number_with_high_confidence(web):
    row = check(web, "consistent")
    assert (row["agreement"], row["confidence"], row["primary_phone"]) == ("consistent", "high", "+14155550101")
    assert row["site_reachable"] is True and row["pages_crawled"] == 2
    assert {"name", "website_url", "phones", "confidence_reason", "final_url", "checked_at"} <= set(row)
    assert web.other_hits() == []


def test_conflicting_site_reports_both_numbers(web):
    row = check(web, "conflicting")
    assert (row["agreement"], row["confidence"]) == ("conflicting", "low")
    assert {p["phone"] for p in row["phones"]} == {"+14155550102", "+14155550177"}


def test_none_found_site(web):
    row = check(web, "none_found")
    assert (row["agreement"], row["primary_phone"], row["phones"]) == ("none_found", None, [])


def test_a_link_to_another_host_is_never_followed(web):
    row = check(web, "cross_host")
    assert web.other_hits() == []
    assert row["primary_phone"] == "+14155550105" and row["agreement"] == "consistent"
    assert "+14155550199" not in str(row)
    assert all(s["source_url"].startswith(SITE + "/cross_host/") for p in row["phones"] for s in p["sources"])


def test_a_redirect_to_another_host_is_not_followed(web):
    row = run(verify_business("Vendor", f"{SITE}/redirect_other_host/index.html", transport=web.transport))
    assert web.other_hits() == [] and row["pages_crawled"] == 0 and row["phones"] == [] and row["agreement"] == "none_found"


def test_a_bad_website_url_is_a_row_not_an_error(web):
    row = run(verify_business("Vendor", "not a url", transport=web.transport))
    assert row["agreement"] == "none_found" and "Not checked" in row["confidence_reason"] and web.hits == []


# ---------------------------------------------------------------- LocalContactFinder: the same lookup contract as the Apify finder


def test_local_finder_finds_the_consistent_number_with_its_proof_page(web):
    result = run(contacts.LocalContactFinder(web.transport).lookup(vendor("consistent")))
    assert result.status == "found" and result.contact.phone == "+14155550101" and result.contact.source == "website"
    assert result.source_url.startswith(f"{SITE}/consistent/") and result.actor_run_id is None
    assert contacts.health.degraded is False and contacts.health.last_ok_at is not None


@pytest.mark.parametrize("folder", ["conflicting", "none_found", "redirect_other_host"])
def test_local_finder_never_offers_a_number_it_cannot_trust(web, folder):
    result = run(contacts.LocalContactFinder(web.transport).lookup(vendor(folder)))
    assert result.status == "not_usable" and result.contact is None
    assert web.other_hits() == []


def test_local_finder_never_returns_a_number_from_another_host(web):
    result = run(contacts.LocalContactFinder(web.transport).lookup(vendor("cross_host")))
    assert result.status in ("found", "not_usable") and web.other_hits() == []
    if result.contact is not None:
        assert result.contact.phone == "+14155550105" and result.contact.source_url.startswith(f"{SITE}/cross_host/")


def test_local_finder_caches_a_result_and_skips_a_vendor_without_a_website(web):
    v = vendor("consistent")
    first = run(contacts.LocalContactFinder(web.transport).lookup(v))
    hits = len(web.hits)
    second = run(contacts.LocalContactFinder(web.transport).lookup(v))
    assert first.cached is False and second.cached is True and len(web.hits) == hits
    no_site = Vendor(id="ven_none", name="Vendor", trade="supply", email_domain="vendor.example", website_url=None)
    assert run(contacts.LocalContactFinder(web.transport).lookup(no_site)).status == "no_website"


def test_a_crawler_crash_is_unavailable_not_an_exception(web, monkeypatch):
    async def boom(*a, **kw):
        raise RuntimeError("crash")

    monkeypatch.setattr("app.services.vendor_contact.verify_business", boom)
    result = run(contacts.LocalContactFinder(web.transport).lookup(vendor("consistent")))
    assert result.status == "unavailable" and result.error == "RuntimeError" and contacts.health.degraded is True


# ---------------------------------------------------------------- the provider setting


def test_get_finder_picks_the_local_finder_only_when_asked(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "mock_apify", False)
    monkeypatch.setattr(s, "contacts_provider", "local")
    assert isinstance(contacts.get_finder(), contacts.LocalContactFinder)
    monkeypatch.setattr(s, "contacts_provider", "apify")
    finder = contacts.get_finder()
    assert isinstance(finder, contacts.RealContactFinder) and not isinstance(finder, contacts.LocalContactFinder)
    monkeypatch.setattr(s, "mock_apify", True)
    monkeypatch.setattr(s, "contacts_provider", "local")
    assert isinstance(contacts.get_finder(), contacts.MockContactFinder)


def test_contacts_provider_reads_the_environment(monkeypatch):
    from app.config import Settings

    monkeypatch.setenv("MOCK_APIFY", "false")
    monkeypatch.setenv("CONTACTS_PROVIDER", "local")
    s = Settings()
    assert s.mock_apify is False and s.contacts_provider == "local"
    monkeypatch.setenv("CONTACTS_PROVIDER", "bogus")
    with pytest.raises(ValueError):
        Settings()


def test_local_lookup_is_ready_without_an_apify_token(monkeypatch):
    from app.integrations import integration_status

    s = get_settings()
    monkeypatch.setattr(s, "apify_token", "")
    monkeypatch.setattr(s, "contacts_provider", "local")
    assert integration_status()["apify"]["key_set"] is True
    monkeypatch.setattr(s, "contacts_provider", "apify")
    assert integration_status()["apify"]["key_set"] is False


def test_status_row_names_the_built_in_crawler_in_local_mode(monkeypatch):
    from app.services import status

    s = get_settings()
    monkeypatch.setattr(s, "contacts_provider", "local")
    assert status._apify_row(s)["name"] == "Vendor phone lookup (built-in crawler)"
    monkeypatch.setattr(s, "contacts_provider", "apify")
    assert status._apify_row(s)["name"] == "Vendor phone lookup (Apify)"
