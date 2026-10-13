"""The Fabric Ingest_Studio notebook sums studio_user_daily into studio_tenant_daily, as the Azure job does."""
import json

import pytest

import notebook_source
from valuelens_jobs.collect import studio

NOTEBOOK = "credit-consumption/Ingest_Studio.ipynb"
NS = notebook_source.namespace(NOTEBOOK, {"API_SOURCE", "API_USER_SOURCE", "API_SOURCES", "API_BILLING_PLAN"})


def _cells():
    return ["".join(c["source"]) for c in
            json.loads((notebook_source.NOTEBOOKS / NOTEBOOK).read_text(encoding="utf-8"))["cells"]]


def test_provenance_constants_match_the_azure_job():
    assert NS["API_SOURCE"] == studio.API_SOURCE
    assert NS["API_USER_SOURCE"] == studio.API_USER_SOURCE == "ppac-api-users"
    assert NS["API_BILLING_PLAN"] == studio.API_BILLING_PLAN
    assert set(NS["API_SOURCES"]) == {studio.API_SOURCE, studio.API_USER_SOURCE}


@pytest.mark.parametrize("prepaid, payg, entitled, share", [
    (75, 25, 1000, 0.75), (0, 0, 5, 1.0), (0, 0, 0, 0.0), (None, None, None, 0.0), (0, 10, 0, 0.0)])
def test_prepaid_share(prepaid, payg, entitled, share):
    assert NS["prepaid_share"](prepaid, payg, entitled) == share


def test_tenant_from_users_runs_after_the_per_user_cell_and_before_the_check():
    cells = _cells()
    users = next(i for i, s in enumerate(cells) if "user_raw = read(*PAT_API_USER" in s)
    fallback = next(i for i, s in enumerate(cells) if "F.lit(API_USER_SOURCE).alias(\"source_file\")" in s)
    check = next(i for i, s in enumerate(cells) if s.startswith("## Check"))
    assert users < fallback < check
    body = cells[fallback]
    # Rebuilt every run, only where no export or agent row covers the day and environment.
    assert "delete(F.col(\"source_file\") == API_USER_SOURCE)" in body
    assert "left_anti" in body
    assert "F.col(\"billed\") * F.lit(share) + F.col(\"non_billed\")" in body


def test_exports_replace_both_kinds_of_api_row():
    helpers = next(s for s in _cells() if "def drop_api_rows" in s)
    assert "t.source_file IN ('{API_SOURCE}', '{API_USER_SOURCE}')" in helpers
    agent_api = next(s for s in _cells() if "api_raw = read(*PAT_API_AGENT" in s)
    assert "isin(*API_SOURCES)" in agent_api and "share, allocated = entitlement()" in agent_api
