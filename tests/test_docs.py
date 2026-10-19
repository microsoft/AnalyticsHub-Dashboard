"""Docs links resolve, old anchors still land, and the wiki publisher rewrites links."""
from __future__ import annotations

import importlib.util
import re
from pathlib import Path
from urllib.parse import unquote

import pytest

ROOT = Path(__file__).resolve().parents[1]

spec = importlib.util.spec_from_file_location("publish_wiki", ROOT / ".github" / "scripts" / "publish_wiki.py")
publish_wiki = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publish_wiki)

CHECKED = sorted(
    [*(ROOT / "docs").glob("*.md"), *(ROOT / "docs" / "wiki").glob("*.md"), *(ROOT / "ideas").glob("**/*.md")]
    + [ROOT / p for p in ("README.md", "CONTRIBUTING.md", "1-fabric/README.md", "2-azure/README.md",
                          "fabric/README.md", "azure/README.md", "installer/README.md", "fabric/MANUAL-SETUP.md")]
)

LINK = re.compile(r'!?\[(?:[^\[\]]|\[[^\]]*\])*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)')
FENCE = re.compile(r"^(```|~~~).*?^\1", re.M | re.S)


def strip_code(text: str) -> str:
    return FENCE.sub("", text)


def slug(heading: str) -> str:
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", heading)
    text = re.sub(r"<[^>]+>", "", text).strip().lower()
    text = re.sub(r"[^\w\- ]", "", text)
    return text.replace(" ", "-")


def anchors(path: Path) -> set[str]:
    found, seen = set(), {}
    text = strip_code(path.read_text(encoding="utf-8"))
    for m in re.finditer(r"^#{1,6}\s+(.+?)\s*#*\s*$", text, re.M):
        base = slug(m.group(1))
        n = seen.get(base, 0)
        seen[base] = n + 1
        found.add(base if n == 0 else f"{base}-{n}")
    found.update(re.findall(r'<a\s+(?:id|name)="([^"]+)"', text))
    return found


def links(path: Path):
    for target in LINK.findall(strip_code(path.read_text(encoding="utf-8"))):
        if re.match(r"^[a-z][a-z0-9+.-]*:", target, re.I) or target.startswith("//"):
            continue
        yield target


@pytest.mark.parametrize("path", CHECKED, ids=lambda p: p.relative_to(ROOT).as_posix())
def test_relative_links_and_anchors_resolve(path):
    broken = []
    for target in links(path):
        file, _, anchor = target.partition("#")
        dest = (path.parent / unquote(file)).resolve() if file else path
        if not dest.exists():
            broken.append(f"{target}: no such file")
        elif anchor and dest.suffix == ".md" and anchor not in anchors(dest):
            broken.append(f"{target}: no such heading")
    assert not broken, "\n".join(broken)


@pytest.mark.parametrize(
    "page, anchor",
    [
        ("README.md", "disclaimer"),
        ("README.md", "getting-started"),
        ("README.md", "power-bi-reports"),
        ("README.md", "optional-add-ons"),
        ("README.md", "reference"),
        ("README.md", "whats-here"),
        ("README.md", "repository-layout"),
        ("docs/MANUAL-INSTALL.md", "1-prerequisites"),
        ("docs/MANUAL-INSTALL.md", "2-install"),
        ("docs/MANUAL-INSTALL.md", "3-verify"),
        ("fabric/README.md", "set-it-up-by-hand"),
        ("fabric/MANUAL-SETUP.md", "steps"),
        ("docs/PREREQUISITES.md", "send-this-to-your-viva-insights-analyst-first"),
        ("docs/PREREQUISITES.md", "optional-extras"),
        ("docs/PREREQUISITES.md", "power-platform-admin-for-the-copilot-studio-credits-flow"),
        ("docs/PREREQUISITES.md", "what-it-costs"),
        ("docs/PREREQUISITES.md", "how-long-it-takes"),
        ("docs/PERMISSIONS.md", "core-sources-required"),
        ("docs/PERMISSIONS.md", "azure-resource-graph"),
        ("docs/PERMISSIONS.md", "viewing-analytics-hub-paths-1-and-2"),
        ("docs/PERMISSIONS.md", "org-scoped-access-row-level-security"),
        # CHANGELOG.md links the Teams heading by its old name.
        ("docs/PERMISSIONS.md", "publishing-the-teams-app-path-2"),
        # Hard-coded in installer/packaging/signing.js and in older release notes.
        ("installer/README.md", "without-the-exe"),
        ("installer/README.md", "from-powershell"),
        ("installer/README.md", "check-the-download"),
        ("installer/README.md", "locked-down-tenant--azure-cloud-shell"),
        ("installer/README.md", "run-it"),
        ("installer/README.md", "after-it-finishes"),
        ("installer/README.md", "troubleshooting"),
        ("installer/README.md", "before-you-start"),
        # Hard-coded in installer/packaging/signing.js and launcher/install.ps1.
        ("docs/INSTALL.md", "without-the-exe"),
        ("docs/INSTALL.md", "from-powershell"),
        ("docs/INSTALL.md", "it-approved-nodejs"),
        ("docs/INSTALL.md", "check-the-download"),
        ("docs/INSTALL.md", "locked-down-tenant--azure-cloud-shell"),
        ("docs/INSTALL.md", "run-it"),
        # Verify, Uninstall and Known issues moved into Install, Update and Troubleshooting.
        # Older release notes and installers still link the old pages.
        ("docs/INSTALL.md", "check-it-worked"),
        ("docs/INSTALL.md", "after-it-finishes"),
        ("docs/VERIFY.md", "after-it-finishes"),
        ("docs/UPDATE.md", "uninstall"),
        ("docs/TROUBLESHOOTING.md", "known-issues"),
        ("docs/KNOWN-ISSUES.md", "installing"),
        ("docs/KNOWN-ISSUES.md", "unsigned-files-in-the-download"),
        # The old Update title and wiki Home sections, which older wiki links use.
        ("docs/UPDATE.md", "update"),
        ("docs/wiki/Home.md", "automatic-installer"),
        ("docs/wiki/Home.md", "manual-by-hand-fabric"),
        # The Copilot Managed App is parked in ideas/. Its old page and sections keep their anchors.
        ("docs/MANAGED-APP.md", "how-it-works"),
        ("docs/MANAGED-APP.md", "before-you-start"),
        ("docs/MANAGED-APP.md", "steps"),
        ("docs/MANAGED-APP.md", "whats-different-from-fabric-and-azure"),
        ("docs/MANAGED-APP.md", "check-it-worked"),
        ("docs/MANAGED-APP.md", "if-something-goes-wrong"),
        ("README.md", "copilot-managed-app-preview"),
        ("docs/wiki/Home.md", "copilot-managed-app-preview"),
        ("docs/ARCHITECTURE.md", "copilot-managed-app"),
        ("docs/PERMISSIONS.md", "copilot-managed-app"),
    ],
)
def test_old_anchors_still_land(page, anchor):
    assert anchor in anchors(ROOT / page)


def test_prerequisites_summary_fits_on_one_screen():
    text = (ROOT / "docs" / "PREREQUISITES.md").read_text(encoding="utf-8")
    summary = text.split("## At a glance", 1)[1].split("\n## ", 1)[0]
    assert len(summary.strip().splitlines()) <= 30


@pytest.mark.parametrize(
    "target, source, expected",
    [
        ("INSTALL.md#from-powershell", "docs/VERIFY.md", "Install#from-powershell"),
        ("#at-a-glance", "docs/PREREQUISITES.md", "#at-a-glance"),
        ("../PREREQUISITES.md", "docs/wiki/Home.md", "Prerequisites"),
        ("Home.md", "docs/wiki/_Sidebar.md", "Home"),
        ("../installer/README.md#networking", "docs/INSTALL.md",
         "https://github.com/o/r/blob/main/installer/README.md#networking"),
        ("../fabric/Add%20Agent%20Evaluator/README.md", "docs/PERMISSIONS.md",
         "https://github.com/o/r/blob/main/fabric/Add%20Agent%20Evaluator/README.md"),
        ("../fabric/", "docs/PERMISSIONS.md", "https://github.com/o/r/tree/main/fabric"),
        ("../media/AnalyticsHub-Preview.gif", "docs/APP-GUIDE.md",
         "https://github.com/o/r/raw/main/media/AnalyticsHub-Preview.gif"),
        ("https://learn.microsoft.com/x", "docs/INSTALL.md", "https://learn.microsoft.com/x"),
        ("mailto:a@b.c", "docs/INSTALL.md", "mailto:a@b.c"),
    ],
)
def test_rewrite_target(target, source, expected):
    assert publish_wiki.rewrite_target(target, source, "o/r", "main") == expected


def test_rewrite_leaves_code_blocks_alone():
    text = "[a](INSTALL.md)\n```\n[b](INSTALL.md)\n```\n<img src=\"../media/x.png\">\n"
    out = publish_wiki.rewrite(text, "docs/VERIFY.md", "o/r", "main")
    assert "[a](Install)" in out
    assert "[b](INSTALL.md)" in out
    assert 'src="https://github.com/o/r/raw/main/media/x.png"' in out


def test_publish_writes_every_page_and_prunes_stale_ones(tmp_path):
    (tmp_path / "Old-Page.md").write_text(publish_wiki.MARKER + "\nold\n", encoding="utf-8")
    (tmp_path / "Hand-Written.md").write_text("kept\n", encoding="utf-8")
    written = publish_wiki.publish(tmp_path, "o/r", "main")
    assert set(written) == {f"{name}.md" for name in publish_wiki.PAGES.values()}
    assert not (tmp_path / "Old-Page.md").exists()
    assert (tmp_path / "Hand-Written.md").exists()
    pages = set(publish_wiki.PAGES.values())
    for name in written:
        for target in links(tmp_path / name):
            assert target.split("#")[0] in pages or target.startswith("#"), f"{name}: {target}"
