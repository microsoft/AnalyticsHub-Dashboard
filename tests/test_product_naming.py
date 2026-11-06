"""Current branding changes must not rename existing deployment contracts."""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def text(path):
    return (ROOT / path).read_text(encoding="utf-8")


def test_readme_branding_and_legacy_destinations():
    readme = text("README.md")
    assert "# DataHub App - for Microsoft Copilot, Agents, Cowork and Autopilots" in readme
    assert "[DataHub App site](https://microsoft.github.io/Analytics-Hub/)" in readme
    assert "[![DataHub App preview](media/AnalyticsHub-Preview.gif)]" in readme
    assert "**Set up DataHub App**" in readme
    assert "AnalyticsHubInstaller.exe" in readme
    assert "releases/latest/download/install.ps1" in readme
    assert "earlier branding" in readme
    overview = "https://github.com/user-attachments/assets/c62b1fb7-8cb4-46c3-8f0b-aec5cf591e5f"
    assert f"\n\n{overview}\n\n" in readme
    assert readme.index(overview) < readme.index("## Installer")
    assert "synthetic demo data and AI-generated narration" in readme
    for companion in (
        "DataHub-App-Overview-OpenMontage-42s.mp4",
        "DataHub-App-Overview-OpenMontage.en-GB.vtt",
        "DataHub-App-Overview-OpenMontage-transcript.txt",
        "DataHub-App-Overview-OpenMontage-poster.jpg",
    ):
        assert (ROOT / "media" / companion).is_file()
    asset = "https://github.com/user-attachments/assets/d00b4e05-bc97-4aee-9df3-7be16f9a309f"
    for page in (readme, text("docs/INSTALL.md")):
        assert f"\n\n{asset}\n\n" in page
        assert "narration is AI-generated" in page and "uses simulated services" in page
    assert "Analytics Hub dashboard" not in readme


def test_app_source_uses_requested_brand_and_keeps_named_flow():
    for path in (ROOT / "app" / "src").rglob("*"):
        if path.suffix not in {".ts", ".tsx"} or ".spec." in path.name:
            continue
        source = path.read_text(encoding="utf-8")
        assert "Analytics Hub dashboard" not in source, path.relative_to(ROOT)
        assert not re.search(r"\bDataHub\b(?! App)", source), path.relative_to(ROOT)
    assert "Analytics Hub - Agent inventory" in text("app/src/queries/governance/governance-resource-graph.ts")
    assert "<title>DataHub App</title>" in text("app/index.html")
    assert 'pptx.author = "DataHub App"' in text("app/src/lib/report-export.ts")


def test_public_descriptions_include_cowork_and_optional_credits():
    for path, heading in (
        ("README.md", "## What you get"),
        ("docs/wiki/Home.md", "# DataHub App for Microsoft Copilot"),
        ("docs/README.md", "## What you get"),
        ("app/README.md", "# DataHub App"),
    ):
        section = text(path).split(heading, 1)[1].split("\n## ", 1)[0]
        source = " ".join(section.split())
        assert "Cowork" in source, path
        assert "estimated" in source, path
        assert "fit and readiness" in source, path
        assert "optional credit consumption data" in source, path

    manifests = [
        json.loads(text(path))
        for path in (
            "azure/teams/manifest.template.json",
            "installer/src/azure/teams/manifest.template.json",
        )
    ]
    assert manifests[0]["description"] == manifests[1]["description"]
    for manifest in manifests:
        description = manifest["description"]
        assert "Cowork" in description["short"]
        assert len(description["short"]) <= 80
        assert len(description["full"]) <= 4000
        assert "Cowork fit and readiness" in description["full"]
        assert "optional credit consumption data" in description["full"]


def test_installer_branding_and_deployment_identity_are_separate():
    assert "<title>DataHub App installer</title>" in text("installer/src/web/index.html")
    wizard = text("installer/src/web/app.js")
    for copy in (
        "Set up DataHub App",
        "Update DataHub App",
        "Uninstall DataHub App",
        "Manage DataHub App",
    ):
        assert copy in wizard
    assert "'DataHub App is set up'" in wizard
    assert "name: Analytics Hub" in text("app/rayfin/rayfin.yml")
    assert "?? 'Analytics Hub'" in text("installer/src/steps/app.js")
    assert "DEFAULT_WORKSPACE_NAME = 'Analytics Hub'" in text("installer/src/steps/plan.js")
    assert "MODEL_NAME = 'Analytics Hub Model'" in text("installer/src/config.js")
    assert "DATA_AGENT_NAME = 'Analytics Hub Ask'" in text("installer/src/config.js")
    assert "VIEWER_GROUP_NAME = 'Analytics Hub Viewers'" in text("installer/src/steps/access.js")
    assert "READ_ROLE_MARK = 'Created by the Analytics Hub installer'" in text("installer/src/clients/dataverse.js")
    assert "MARKER = 'Set by the Analytics Hub installer'" in text("installer/src/transform/notebook.js")
    assert "NOTEBOOK_SECRET_LABEL = 'Analytics Hub installer'" in text("installer/src/steps/fabric.js")
    assert "const OWNED_NAME = /^Analytics Hub - " in text("installer/src/steps/flows.js")
    assert "=> `Analytics Hub ${az.resourceGroup" in text("installer/src/steps/azure/index.js")


def test_teams_titles_change_but_identity_does_not():
    first = json.loads(text("azure/teams/manifest.template.json"))
    second = json.loads(text("installer/src/azure/teams/manifest.template.json"))
    assert first == second
    assert first["name"] == {"short": "DataHub App", "full": "DataHub App"}
    assert all(tab["name"] == "DataHub App" for tab in first["staticTabs"])
    assert "AnalyticsHub-Dashboard" in first["developer"]["websiteUrl"]
    registration = json.loads(text("azure/infra/web-app-registration.json"))
    assert registration["displayName"] == "Analytics Hub (Azure)"
    assert {role["value"] for role in registration["appRoles"]} == {
        "AnalyticsHub.User", "AnalyticsHub.Admin"
    }
    assert "Allow users to access DataHub App." in text("azure/infra/web-app-registration.json")


def test_launcher_paths_and_future_release_titles():
    launcher = text("installer/packaging/launcher/Launcher.cs")
    assert 'WorkFolder = "Analytics Hub"' in launcher
    assert 'HomeFolder = "AnalyticsHub"' in launcher
    assert 'Console.Title = "DataHub App installer"' in launcher
    script = text("installer/packaging/launcher/install.ps1")
    assert script.isascii()
    assert "Join-Path $Docs 'Analytics Hub'" in script
    assert "Join-Path $env:LOCALAPPDATA 'AnalyticsHub'" in script
    assert '--title "DataHub App installer ${TAG#installer-v}"' in text(".github/workflows/installer-exe.yml")


def test_release_history_and_compatibility_are_explained():
    changelog = text("CHANGELOG.md")
    unreleased = changelog.split("\n## 2026-", 1)[0]
    assert "**DataHub App naming.**" in unreleased
    assert "## Unreleased" in unreleased
    assert "## 2026-10-26 — Analytics Hub installer 0.6.8" in changelog
    guide = text("docs/INSTALL.md")
    assert "## Names and compatibility" in guide
    assert "Resource-display-name and site-path migrations are separate work" in guide
    assert "validated template rebuild or upstream re-pin" in guide
    assert "**Analytics Hub** app, then **Share**" in guide
    assert not re.search(r"\bAH\b", text("scripts/Check-SharePoint-Queries.py"))
    assert "// feedback, plus Microsoft 365 activity where the Analytics Hub installer adds" in text(
        "scripts/Update-Template-Dax.py"
    )


def test_changed_notebook_cells_compile_without_running():
    for name in (
        "AnalyticsHub_Access_Scope", "AnalyticsHub_Load_Status",
        "AnalyticsHub_Support_File", "AnalyticsHub_Upload_Router", "ValueLens_Refresh_Model",
        "credit-consumption/Ingest_Viva_Consumption",
    ):
        notebook = json.loads(text(f"fabric/notebooks/{name}.ipynb"))
        for index, cell in enumerate(notebook["cells"]):
            if cell["cell_type"] == "code":
                source = cell["source"]
                source = "".join(source) if isinstance(source, list) else source
                # Spark's cell magic is not Python; the rest of a Python cell is.
                if not re.match(r"\s*%%", source):
                    compile(source, f"{name}:cell{index}", "exec")
    assert "SUPPORT_PRODUCT = 'DataHub App'" in text("fabric/notebooks/AnalyticsHub_Support_File.ipynb")
