"""The Copilot Managed App stays parked in ideas/.

Nothing in ideas/ is built, run, shipped or supported, so none of it may reach the app's build, CI,
the installer, the Azure images or the setup docs again.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "app"
IDEAS = ROOT / "ideas"
PARKED = IDEAS / "managed-app"

MANAGED_SOURCE = re.compile(
    r"""managed-apps|lib/managed|ManagedAuth|ManagedDiagnostics|ManagedRuntime|MODE\s*[!=]==\s*["']managed["']"""
)
NAMES_IDEAS = re.compile(r"\bideas/")
MANAGED_CI = re.compile(r"build:managed|dev:managed|check-managed-markers")
# The \b matters: "Teams app" contains "ms app".
MANAGED_INSTALLER = re.compile(r"managed-apps?\b|deploy:managed|remove:managed|\bms app\b|ideas/")
COPIES_IDEAS = re.compile(r"^\s*(?:COPY|ADD)\b.*\bideas\b", re.I)
DOC_FORBIDDEN = re.compile(r"MANAGED-APP\.md|build:managed|managed-apps|\bms app\b")
COPILOT_MANAGED = re.compile(r"Copilot\s+Managed", re.I)
ANCHOR_TAG = re.compile(r'<a\s+(?:id|name)="[^"]*"\s*>\s*</a>')
GUID = re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", re.I)
EMAIL = re.compile(r"[\w.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")
FAKE_EMAIL_DOMAINS = {"contoso.com", "example.com"}

# Generated folders that installer/.gitignore keeps out of the repo.
INSTALLER_SKIP = {"node_modules", "valuelens-preview", "dist-exe"}
NOT_IN_IDEAS = {"package.json", "package-lock.json", "node_modules", "dist", "generated", ".ms",
                "ms.config.json", "managed-app.config.json"}

FRONT_DOOR = sorted(
    {ROOT / p for p in ("README.md", "CONTRIBUTING.md", "CHANGELOG.md", "app/README.md", "fabric/README.md",
                        "azure/README.md", "installer/README.md", "fabric/MANUAL-SETUP.md")}
    | {p for p in (ROOT / "docs").glob("*.md") if p.name != "MANAGED-APP.md"}
    | set((ROOT / "docs" / "wiki").glob("*.md"))
    | {p for p in (ROOT / ".github" / "ISSUE_TEMPLATE").iterdir() if p.is_file()}
)


def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def read_text(path: Path) -> str | None:
    data = path.read_bytes()
    if b"\0" in data:
        return None
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return None


def files_under(folder: Path, skip: set[str] = frozenset()) -> list[Path]:
    if not folder.is_dir():
        return []
    return sorted(p for p in folder.rglob("*") if p.is_file() and not skip & set(p.relative_to(folder).parts))


def matching_lines(paths: list[Path], pattern: re.Pattern) -> list[str]:
    hits = []
    for path in paths:
        text = read_text(path)
        if text is None:
            continue
        for n, line in enumerate(text.splitlines(), 1):
            if pattern.search(line):
                hits.append(f"{rel(path)}:{n}: {line.strip()[:160]}")
    return hits


def test_app_package_has_no_managed_scripts_or_dependencies():
    pkg = json.loads((APP / "package.json").read_text(encoding="utf-8"))
    found = [f"script {name}: {cmd}" for name, cmd in pkg.get("scripts", {}).items()
             if "managed" in name.lower() or "managed" in cmd.lower()]
    for section in ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies"):
        found += [f"{section}: {dep}" for dep in pkg.get(section, {}) if dep.startswith("@microsoft/managed-apps")]
    assert not found, "\n".join(found)


def test_app_lock_has_no_managed_packages():
    lock = json.loads((APP / "package-lock.json").read_text(encoding="utf-8"))
    found = [key for key in lock.get("packages", {}) if "node_modules/@microsoft/managed-apps" in key]
    assert not found, "\n".join(found)


def test_app_source_and_configs_have_no_managed_code():
    hits = matching_lines(files_under(APP / "src") + [APP / "vite.config.ts", APP / "eslint.config.js"], MANAGED_SOURCE)
    assert not hits, "\n".join(hits)


def test_app_build_inputs_do_not_reach_into_ideas():
    configs = [p for p in APP.iterdir() if p.is_file() and re.fullmatch(
        r"package\.json|tsconfig[^/]*\.json|(?:vite|vitest)\.config\.[cm]?[jt]s|eslint\.config\.[cm]?js", p.name)]
    assert APP / "package.json" in configs
    hits = matching_lines(configs + files_under(APP / "src"), NAMES_IDEAS)
    assert not hits, "\n".join(hits)


def test_ci_does_not_build_or_check_the_parked_app():
    workflows = sorted((ROOT / ".github" / "workflows").glob("*.y*ml"))
    assert workflows
    hits = matching_lines(workflows, MANAGED_CI)
    assert not hits, "\n".join(hits)


def test_codeql_still_scans_ideas():
    # No paths or paths-ignore may leave ideas/ out of the security scan.
    config = [ROOT / ".github" / "workflows" / "codeql.yml", *files_under(ROOT / ".github" / "codeql")]
    hits = matching_lines(config, re.compile(r"ideas", re.I))
    assert not hits, "\n".join(hits)


def test_installer_has_no_managed_route():
    hits = matching_lines(files_under(ROOT / "installer", INSTALLER_SKIP), MANAGED_INSTALLER)
    assert not hits, "\n".join(hits)


def test_azure_images_do_not_copy_ideas():
    dockerfiles = sorted(p for p in (ROOT / "azure").rglob("Dockerfile*") if p.is_file())
    assert dockerfiles
    hits = matching_lines(dockerfiles, COPIES_IDEAS)
    assert not hits, "\n".join(hits)


@pytest.mark.parametrize("path", FRONT_DOOR, ids=rel)
def test_front_door_docs_mention_it_only_as_parked(path):
    text = ANCHOR_TAG.sub("", path.read_text(encoding="utf-8"))
    found = []
    for paragraph in re.split(r"\n\s*\n", text):
        flat = " ".join(paragraph.split())
        if COPILOT_MANAGED.search(flat) and "parked" not in flat.lower():
            found.append(f"not marked parked: {flat[:160]}")
    found += matching_lines([path], DOC_FORBIDDEN)
    assert not found, "\n".join(found)


def test_old_managed_app_page_is_a_short_parked_stub():
    text = (ROOT / "docs" / "MANAGED-APP.md").read_text(encoding="utf-8")
    assert len(text.splitlines()) <= 40
    assert "parked" in text.lower()
    assert "](../ideas/managed-app/" in text


@pytest.mark.parametrize("path", [IDEAS / "README.md", PARKED / "README.md"], ids=rel)
def test_ideas_readmes_say_parked_and_still_scanned(path):
    text = " ".join(path.read_text(encoding="utf-8").split()).lower()
    for phrase in ("parked", "not supported", "source downloads", "scanned", "checked"):
        assert phrase in text, f"{rel(path)} doesn't say {phrase!r}"


def test_setup_notes_start_with_the_historical_banner():
    blocks = re.split(r"\n\s*\n", (PARKED / "SETUP.md").read_text(encoding="utf-8").strip())
    assert blocks[0].startswith("# ")
    assert blocks[1].startswith(">")
    banner = " ".join(line.lstrip("> ").strip() for line in blocks[1].splitlines())
    assert "Historical reference, not working steps" in banner
    assert "Not validated against current services" in banner


def test_ideas_holds_no_installable_or_generated_files():
    found = [rel(p) for p in IDEAS.rglob("*")
             if p.name in NOT_IN_IDEAS or re.fullmatch(r"ms\.[^/]+\.config\.json", p.name)]
    found += [f"{rel(p)}: {p.stat().st_size} bytes" for p in files_under(IDEAS) if p.stat().st_size > 200 * 1024]
    assert not found, "\n".join(found)


def test_ideas_has_only_placeholder_ids_and_emails():
    found = []
    for path in files_under(IDEAS):
        text = read_text(path)
        if text is None:
            continue
        for match in GUID.finditer(text):
            digits = match.group(0).replace("-", "").lower()
            # Skip the version and variant digits: 11111111-1111-4111-8111-111111111111 is a placeholder.
            if len(set(digits[:12] + digits[13:16] + digits[17:])) != 1:
                found.append(f"{rel(path)}: {match.group(0)}")
        for match in EMAIL.finditer(text):
            if match.group(0).rsplit("@", 1)[1].lower() not in FAKE_EMAIL_DOMAINS:
                found.append(f"{rel(path)}: {match.group(0)}")
    assert not found, "\n".join(found)
