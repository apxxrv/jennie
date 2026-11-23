# Copied from apify/vendor-contact-verifier/src/main.py (without the Apify SDK); keep the two in sync.
"""Vendor Contact Verifier inside the backend: the Actor's crawler, run in this process. One business in, one dataset row out
(the same dict the Actor writes to its dataset, so contacts.parse_actor_row reads it unchanged)."""

import logging
from typing import Any, Optional
from urllib.parse import urlparse

import httpx

from .assess import build_row, failed_row
from .crawl import crawl_site

log = logging.getLogger("jenny.vendor_contact")

DEFAULT_EXTRA_PATHS = ["/contact", "/contact-us", "/about"]
MAX_PAGES_LIMIT = 30


def validate(business: Any) -> tuple[str, str, str | None]:
    """(name, website_url, problem). problem is None for a usable business."""
    if not isinstance(business, dict):
        return "", "", "Each business must be an object with name and website_url."
    name = str(business.get("name") or "").strip()
    url = str(business.get("website_url") or "").strip()
    if not name:
        return name, url, "Missing name."
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return name, url, "website_url must be a full http:// or https:// URL."
    return name, url, None


def read_options(data: dict) -> tuple[int, list[str], float]:
    max_pages = int(data.get("maxPagesPerSite") or 10)
    paths = data.get("extraPaths")
    timeout = float(data.get("requestTimeoutSecs") or 15)
    return max(1, min(max_pages, MAX_PAGES_LIMIT)), [str(p) for p in (DEFAULT_EXTRA_PATHS if paths is None else paths)], max(1.0, timeout)


async def check_business(business: Any, max_pages: int, extra_paths: list[str], timeout: float,
                         transport: Optional[httpx.AsyncBaseTransport] = None) -> dict:
    name, url, problem = validate(business)
    if problem:
        return failed_row(name, url, f"Not checked: {problem}")
    try:
        crawl = await crawl_site(url, max_pages=max_pages, extra_paths=extra_paths, timeout=timeout, transport=transport)
        return build_row(name, url, crawl)
    except Exception as exc:  # one bad site must never fail the lookup
        log.exception("Check failed for %s", name)
        return failed_row(name, url, f"Check failed: {type(exc).__name__}.")


async def verify_business(name: str, website_url: str, max_pages: int = 6, request_timeout_secs: int = 6, *,
                          transport: Optional[httpx.AsyncBaseTransport] = None) -> dict:
    """Crawl website_url (only that host, inside its folder) and return the Actor's dataset row for this business.
    `transport` is for tests (an httpx mock transport); production leaves it None."""
    max_pages_, extra_paths, timeout = read_options({"maxPagesPerSite": max_pages, "requestTimeoutSecs": request_timeout_secs})
    return await check_business({"name": name, "website_url": website_url}, max_pages_, extra_paths, timeout, transport)
