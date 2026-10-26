"""The AnalyticsHub_Support_File notebook writes the same redacted support file as the installer's --support-bundle."""
from __future__ import annotations

import io
import json
import zipfile
from datetime import datetime, timezone

from notebook_source import namespace

NB = namespace("AnalyticsHub_Support_File.ipynb", {
    "SUPPORT_PRODUCT", "SUPPORT_PREFIX", "SECRET_KEY", "PERSON_KEY", "GUID", "ISO_DATE", "EMAIL", "SECRET_TEXT",
    "LONG_BASE64", "RESOURCE_PATH", "ANSI", "REDACTION_RULES", "LOG_PATTERNS", "ERROR_LINE"})
SALT = bytes(16)
JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLWJ5dGVz"
CLIENT_SECRET = "abc8Q~ZyXwVuTsRqPoNmLkJiHgFeDcBa0123456789"
WS = "11111111-2222-3333-4444-555555555555"


def test_hash_matches_the_installer():
    # installer/test/support.test.js checks the same value for the JavaScript copy.
    assert NB["Redactor"](SALT).hash("  Ada.Lovelace@Contoso.com ") == "user-1a37274c6a"


def test_free_text_secrets_are_removed_and_ids_kept():
    r = NB["Redactor"](SALT)
    text = "\n".join([
        f"Authorization: Bearer {JWT}",
        f"client secret {CLIENT_SECRET}",
        "https://a.blob.core.windows.net/c?sv=2024&sig=AbCdEf123%2B&se=2026",
        "client_secret=hunter2&grant_type=client_credentials",
        f"workspace {WS} at /subscriptions/{WS}/resourceGroups/rg/providers/Microsoft.App/jobs/x",
    ])
    out = r.text(text)
    for leak in (JWT, CLIENT_SECRET, "AbCdEf123", "hunter2"):
        assert leak not in out
    assert "Bearer [removed]" in out
    assert "grant_type=client_credentials" in out
    assert out.count(WS) == 2
    assert r.counts["secrets"] >= 4


def test_values_people_and_secrets_are_redacted():
    r = NB["Redactor"](SALT)
    value = {
        "app": {"appId": WS, "secret": "xyz", "secretExpires": "2027-04-01T00:00:00Z"},
        "user": {"upn": "ada@contoso.com", "displayName": "Ada Lovelace"},
        "owner": "guest_example.com#EXT#@contoso.onmicrosoft.com",
        "note": "Ada Lovelace started it",
    }
    r.learn(value)
    out = r.value(value)
    assert out["app"] == {"appId": WS, "secret": "[removed]", "secretExpires": "2027-04-01T00:00:00Z"}
    assert out["user"]["upn"] == r.hash("ada@contoso.com")
    assert out["user"]["displayName"] == r.hash("Ada Lovelace")
    assert out["note"] == f"{r.hash('Ada Lovelace')} started it"
    s = json.dumps(out)
    for leak in ("Ada", "contoso", "#EXT#", "xyz"):
        assert leak not in s


def test_files_follow_the_installer_layout():
    s = {
        "installerVersion": None,
        "madeBy": "the AnalyticsHub_Support_File notebook",
        "createdAt": "2026-10-26T09:05:07.000Z",
        "route": "fabric",
        "signedIn": True,
        "user": {"upn": "ada@contoso.com"},
        "settings": {"fabric": {"workspaceId": WS}, "app": {"secret": CLIENT_SECRET}},
        "lastRun": NB["not_collected"]("The notebook doesn't see installer runs."),
        "prereqs": NB["not_collected"]("The notebook doesn't check prerequisites."),
        "runs": {"pipeline": [{"status": "Failed", "error": f"429 for ada@contoso.com, Bearer {JWT}"}]},
        "rowCounts": {"lakehouse": {"copilot_interactions_curated": 0}},
        "logsSummary": {"runErrors": NB["summarise_log"]("window 2 of 12: HTTP 429\nERROR timed out")},
    }
    files = NB["build_support_files"](s, SALT)
    assert [n for n, _ in files] == ["README.txt", "manifest.json", "settings.json", "last-run.json",
                                     "prereqs.json", "runs.json", "row-counts.json", "logs-summary.json"]
    text = "\n".join(t for _, t in files)
    for leak in (JWT, CLIENT_SECRET, "ada@contoso.com"):
        assert leak not in text
    manifest = json.loads(files[1][1])
    assert list(manifest) == ["product", "installerVersion", "madeBy", "createdAt", "route", "signedIn", "files", "redaction"]
    assert manifest["product"] == "Analytics Hub"
    assert [f["name"] for f in manifest["files"]] == ["README.txt"] + [n for n, _ in files[2:]]
    logs = json.loads(files[7][1])["runErrors"]
    assert logs["http429"] == 1 and logs["timeouts"] == 1 and logs["windows"] == 1

    with zipfile.ZipFile(io.BytesIO(NB["support_zip"](files))) as z:
        assert z.namelist() == [n for n, _ in files]
        assert z.read("settings.json").decode("utf-8") == files[2][1]


def test_file_name_matches_the_installer():
    d = datetime(2026, 10, 26, 9, 5, 7, tzinfo=timezone.utc)
    assert NB["support_file_name"](d) == "analyticshub-support-20261026-090507.zip"
