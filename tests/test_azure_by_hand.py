"""Azure by hand: the page's own bash blocks, run against stand-ins.

The blocks come straight from docs/MANUAL-INSTALL.md. az and curl are bash functions that answer
from files, and git clones a local repo, so nothing reaches Azure, Power BI, Graph, GitHub or
GHCR, and nothing real is deleted.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
DOC = (ROOT / "docs" / "MANUAL-INSTALL.md").read_text(encoding="utf-8")
REPO = "https://github.com/microsoft/AnalyticsHub-Dashboard"
LATEST = REPO + "/releases/tag/installer-v"


def _bash() -> str | None:
    if os.name == "nt":
        # Git for Windows. The bash.exe on PATH can be WSL's, which can't see these paths.
        path = Path(os.environ.get("ProgramFiles", r"C:\Program Files"), "Git", "bin", "bash.exe")
        return str(path) if path.exists() else None
    return shutil.which("bash")


BASH = _bash()
pytestmark = pytest.mark.skipif(not BASH or not shutil.which("git"), reason="needs bash and git")


def block(lead: str) -> str:
    """The first bash block after the paragraph that starts with `lead`."""
    found = re.compile(r"^```bash\n(.*?)^```", re.M | re.S).search(DOC, DOC.index(lead))
    assert found, lead
    return found.group(1)


GET_FILES = block("**Get the files.**")
SETUP = block("**Each time Cloud Shell opens**")
REMOVE = block("**Remove.**")

# Stand-ins. Each answers only the exact calls the page makes; anything else is recorded and fails.
STUBS = r"""
PATH="$(cd "$HOME/.guard" && pwd):$PATH"
log() { printf '%s\n' "$*" >> "$STATE/log"; }
fails() { [ -e "$STATE/fail-all" ] || [ -e "$STATE/fail-$1" ]; }
err() { echo "ERROR: $1" >&2; return "${2:-1}"; }
command -v jq >/dev/null || jq() {
  "$PYEXE" -c 'import json, sys
v = json.load(sys.stdin)
for k in sys.argv[1].strip(".").split("."): v = v[k]
sys.stdout.buffer.write(f"{v}\n".encode())' "$2"
}
az() {
  log "az $*"
  # The resource group is in sub-1. Without --subscription, a call goes to the one signed in to.
  local sub a=(); sub=$(cat "$STATE/current")
  while [ $# -gt 0 ]; do
    if [ "$1" = --subscription ]; then
      [[ $2 == [!-]* ]] || { err "argument --subscription: expected one argument" 2; return; }
      sub=$2; shift 2
    else a+=("$1"); shift; fi
  done
  set -- "${a[@]}"
  case "$*" in
  "deployment group show -g analytics-hub -n analytics-hub --query properties.outputs.identityPrincipalId.value -o tsv")
    fails deployment-show && { err simulated; return; }
    [ "$sub" = sub-1 ] && [ -e "$STATE/rg" ] && echo mi-1 || err ResourceGroupNotFound 3 ;;
  "rest -u https://api.powerbi.com/v1.0/myorg/groups --resource https://analysis.windows.net/powerbi/api --query length(value[?id=='ws-1']) -o tsv")
    fails workspace-list && { err simulated; return; }
    [ -e "$STATE/workspace" ] && echo 1 || echo 0 ;;
  "rest -m DELETE -u https://api.powerbi.com/v1.0/myorg/groups/ws-1 --resource https://analysis.windows.net/powerbi/api")
    fails workspace-delete && { err simulated; return; }
    rm "$STATE/workspace" 2>/dev/null || err NotFound ;;
  "ad app list --app-id "*" --query length(@) -o tsv")
    fails app-list && { err simulated; return; }
    [ -e "$STATE/app-$5" ] && echo 1 || echo 0 ;;
  "ad app delete --id "*)
    fails "app-delete-$5" && { err simulated; return; }
    rm "$STATE/app-$5" 2>/dev/null || err "Resource does not exist" ;;
  "group show -n analytics-hub --query properties.provisioningState -o tsv")
    fails group-show && { err simulated; return; }
    [ "$sub" = sub-1 ] && cat "$STATE/rg" 2>/dev/null || err ResourceGroupNotFound 3 ;;
  "group delete -n analytics-hub --yes --no-wait")
    fails group-delete && { err simulated; return; }
    [ "$sub" = sub-1 ] && [ -e "$STATE/rg" ] && echo Deleting > "$STATE/rg" || err ResourceGroupNotFound 3 ;;
  "group exists -n analytics-hub")
    fails group-exists && { err simulated; return; }
    [ "$sub" = sub-1 ] && [ -e "$STATE/rg" ] && echo true || echo false ;;
  "account show --query id -o tsv")
    echo "$sub" ;;
  *) printf '%s\n' "az $*" >> "$STATE/unexpected"; err "unexpected call" 99 ;;
  esac
}
curl() {
  log "curl $*"
  local url=${@: -1}
  case "$url" in
  https://github.com/microsoft/AnalyticsHub-Dashboard/releases/latest)
    [ -s "$STATE/latest" ] || { err "Could not resolve host" 6; return; }
    printf '%s' "$(cat "$STATE/latest")" ;;
  "https://ghcr.io/token?scope=repository:microsoft/"*":pull")
    echo '{"token": "tok"}' ;;
  https://ghcr.io/v2/microsoft/*/manifests/*)
    [[ " $* " == *" Authorization: Bearer tok "* ]] || { err "401 Unauthorized" 22; return; }
    local image=${url#https://ghcr.io/v2/microsoft/}
    [ -e "$STATE/image-${image%%/*}-${image##*/}" ] || err "404 Not Found" 22 ;;
  *) printf '%s\n' "curl $*" >> "$STATE/unexpected"; err "unexpected call" 99 ;;
  esac
}
"""


def run(home: Path, state: Path, *blocks: str) -> subprocess.CompletedProcess:
    """Runs the blocks in bash, as if pasted one after another, with only the stand-ins to call."""
    guard = home / ".guard"
    guard.mkdir(parents=True, exist_ok=True)
    for name in ("az", "curl"):  # In case a stand-in is ever missed: fail, and say so.
        (guard / name).write_text('#!/bin/sh\necho "$0 $*" >> "$STATE/real"\nexit 97\n', newline="\n")
        (guard / name).chmod(0o755)
    script = state / "run.sh"
    script.write_text(STUBS + "\n".join(blocks), encoding="utf-8", newline="\n")
    env = {
        **os.environ,
        "HOME": home.as_posix(),
        "STATE": state.as_posix(),
        "PYEXE": Path(sys.executable).as_posix(),
        "AZURE_CONFIG_DIR": (state / "azure-config").as_posix(),
        "GIT_CONFIG_GLOBAL": (home / ".gitconfig").as_posix(),
        "GIT_CONFIG_NOSYSTEM": "1",
    }
    result = subprocess.run(
        [BASH, "--noprofile", "--norc", script.as_posix()],
        env=env, capture_output=True, encoding="utf-8", errors="replace", timeout=180,
    )
    assert not (state / "unexpected").exists(), (state / "unexpected").read_text()
    assert not (state / "real").exists(), (state / "real").read_text()
    return result


def calls(state: Path) -> list[str]:
    log = state / "log"
    return log.read_text(encoding="utf-8").splitlines() if log.exists() else []


# Remove

GROUP_DELETE = "az group delete -n analytics-hub --subscription sub-1 --yes --no-wait"


@pytest.fixture
def install(tmp_path):
    """A finished install in sub-1: its record, and the workspace, two apps and resource group it
    names. Signed in to sub-1."""
    home, state = tmp_path / "home", tmp_path / "state"
    infra = home / "AnalyticsHub-Dashboard" / "azure" / "infra"
    infra.mkdir(parents=True)
    state.mkdir()
    text = (ROOT / "azure" / "infra" / "main.bicepparam").read_text(encoding="utf-8")
    for old, new in (
        ("var subscription = ''", "var subscription = 'sub-1'"),
        ("param webClientId = ''", "param webClientId = 'web-1'"),
        ("param sqlReaderClientId = ''", "param sqlReaderClientId = 'reader-1'"),
        ("var workspace = ''", "var workspace = 'ws-1'"),
    ):
        assert old in text
        text = text.replace(old, new)
    record = infra / "my.bicepparam"
    record.write_text(text, encoding="utf-8", newline="\n")
    for name in ("workspace", "app-web-1", "app-reader-1"):
        (state / name).touch()
    (state / "rg").write_text("Succeeded\n", newline="\n")
    (state / "current").write_text("sub-1\n", newline="\n")
    return SimpleNamespace(home=home, state=state, record=record, text=text)


def remove(inst) -> subprocess.CompletedProcess:
    return run(inst.home, inst.state, SETUP, REMOVE)


def left(inst) -> set[str]:
    return {n for n in ("workspace", "app-web-1", "app-reader-1", "rg") if (inst.state / n).exists()}


def test_remove_keeps_the_record_when_every_call_fails(install):
    (install.state / "fail-all").touch()
    r = remove(install)
    assert r.returncode != 0
    assert "Still there: workspace web-app sql-reader resource-group." in r.stdout
    assert "Removed" not in r.stdout
    assert install.record.read_text(encoding="utf-8") == install.text
    assert left(install) == {"workspace", "app-web-1", "app-reader-1", "rg"}


def test_remove_keeps_the_ids_when_one_delete_fails_then_retries_with_them(install):
    (install.state / "fail-app-delete-reader-1").touch()
    r = remove(install)
    assert r.returncode != 0
    assert "Still there: sql-reader resource-group." in r.stdout
    assert install.record.read_text(encoding="utf-8") == install.text
    assert left(install) == {"app-reader-1", "rg"}

    # The cause is fixed and Azure has finished with the group: pasting again finishes the job.
    (install.state / "fail-app-delete-reader-1").unlink()
    (install.state / "rg").unlink()
    r = remove(install)
    assert r.returncode == 0, r.stdout + r.stderr
    assert r.stdout.splitlines()[-1] == "Removed"
    assert not install.record.exists()
    assert left(install) == set()


def test_remove_waits_for_the_resource_group_then_finishes(install):
    r = remove(install)
    assert r.returncode != 0
    assert "Still there: resource-group." in r.stdout
    assert install.record.read_text(encoding="utf-8") == install.text
    assert calls(install.state).count(GROUP_DELETE) == 1
    assert (install.state / "rg").read_text().strip() == "Deleting"

    # Still deleting: it isn't asked again, and the record stays.
    r = remove(install)
    assert r.returncode != 0
    assert "Still there: resource-group." in r.stdout
    assert install.record.read_text(encoding="utf-8") == install.text
    assert calls(install.state).count(GROUP_DELETE) == 1

    # Gone: only now does the record go.
    (install.state / "rg").unlink()
    r = remove(install)
    assert r.returncode == 0, r.stdout + r.stderr
    assert r.stdout.splitlines()[-1] == "Removed"
    assert not install.record.exists()
    assert calls(install.state).count(GROUP_DELETE) == 1


@pytest.mark.parametrize("check", ["workspace-list", "app-list", "group-exists"])
def test_remove_counts_a_failed_check_as_still_there(install, check):
    for name in ("workspace", "app-web-1", "app-reader-1", "rg"):
        (install.state / name).unlink()
    (install.state / f"fail-{check}").touch()
    r = remove(install)
    assert r.returncode != 0
    assert "Still there:" in r.stdout
    assert install.record.read_text(encoding="utf-8") == install.text


def test_step_1_records_the_subscription_before_it_deploys(install):
    start = DOC.index("1. **Deploy**")
    step = DOC[start:DOC.index("2. **Register the apps:**", start)]
    line = "put subscription $(az account show --query id -o tsv)"
    assert step.index(line) < step.index("az group create")
    template = (ROOT / "azure" / "infra" / "main.bicepparam").read_text(encoding="utf-8")
    install.record.write_text(template, encoding="utf-8", newline="\n")
    (install.state / "current").write_text("sub-9\n", newline="\n")
    r = run(install.home, install.state, SETUP, line)
    assert r.returncode == 0, r.stdout + r.stderr
    assert install.record.read_text(encoding="utf-8") == template.replace(
        "var subscription = ''", "var subscription = 'sub-9'"
    )


def test_remove_uses_the_subscription_step_1_recorded(install):
    # Signed in to another subscription, which has no such resource group.
    (install.state / "current").write_text("sub-2\n", newline="\n")
    r = remove(install)
    assert r.returncode != 0
    assert "Still there: resource-group." in r.stdout
    assert install.record.read_text(encoding="utf-8") == install.text
    assert calls(install.state).count(GROUP_DELETE) == 1
    assert (install.state / "rg").read_text().strip() == "Deleting"

    (install.state / "rg").unlink()
    r = remove(install)
    assert r.returncode == 0, r.stdout + r.stderr
    assert r.stdout.splitlines()[-1] == "Removed"
    assert not install.record.exists()


def test_remove_without_a_recorded_subscription_keeps_the_record(install):
    # Nowhere to check the resource group, so it can't say it's gone.
    for name in ("workspace", "app-web-1", "app-reader-1", "rg"):
        (install.state / name).unlink()
    text = install.text.replace("var subscription = 'sub-1'", "var subscription = ''")
    install.record.write_text(text, encoding="utf-8", newline="\n")
    r = remove(install)
    assert r.returncode != 0
    assert "Still there: resource-group." in r.stdout
    assert install.record.read_text(encoding="utf-8") == text
    assert not [c for c in calls(install.state) if c.startswith("az group delete")]


# Get the files


def git(cwd: Path, *args: str, env: dict) -> str:
    return subprocess.run(
        ["git", "-C", str(cwd), *args], env=env, check=True, capture_output=True, encoding="utf-8"
    ).stdout.strip()


@pytest.fixture
def github(tmp_path):
    """GitHub, as a local repo: an old release, one with Azure by hand, a newer tag whose images
    aren't published yet, and unreleased work on main. Plus a clean Cloud Shell home."""
    home, state, origin = tmp_path / "home", tmp_path / "state", tmp_path / "origin"
    for d in (home, state, origin):
        d.mkdir()
    (home / ".gitconfig").write_text(
        f'[url "{origin.as_uri()}"]\n\tinsteadOf = {REPO}\n'
        "[user]\n\tname = Test\n\temail = test@example.com\n"
        "[commit]\n\tgpgSign = false\n[tag]\n\tgpgSign = false\n"
        "[core]\n\tautocrlf = false\n[init]\n\tdefaultBranch = main\n",
        encoding="utf-8", newline="\n",
    )
    env = {**os.environ, "GIT_CONFIG_GLOBAL": str(home / ".gitconfig"), "GIT_CONFIG_NOSYSTEM": "1"}
    git(origin, "init", "-q", env=env)

    def release(version: str, azure_by_hand: bool = True, annotated: bool = False, tag: bool = True):
        infra = origin / "azure" / "infra"
        infra.mkdir(parents=True, exist_ok=True)
        (origin / "installer").mkdir(exist_ok=True)
        (origin / "installer" / "package.json").write_text(json.dumps({"version": version}), newline="\n")
        (infra / "main.bicepparam").write_text(f"// {version}\n", newline="\n")
        if azure_by_hand:
            (infra / "web-app-registration.json").write_text("{}\n", newline="\n")
        git(origin, "add", "-A", env=env)
        git(origin, "commit", "-q", "-m", version, env=env)
        if tag:
            name = f"installer-v{version}"
            git(origin, "tag", *(["-a", "-m", name] if annotated else []), name, env=env)

    release("0.6.6", azure_by_hand=False)
    release("9.9.9", annotated=True)
    release("9.9.10")
    release("unreleased", tag=False)

    def publish(version: str, *images: str):
        for image in images or ("valuelens-jobs", "valuelens-web"):
            (state / f"image-{image}-{version}").touch()

    clone = home / "AnalyticsHub-Dashboard"
    return SimpleNamespace(
        state=state, clone=clone, record=clone / "azure" / "infra" / "my.bicepparam",
        env=env, release=release, publish=publish,
        latest=lambda url: (state / "latest").write_text(url, encoding="utf-8"),
        get=lambda: run(home, state, GET_FILES),
        head=lambda: git(clone, "rev-parse", "HEAD", env=env),
        branch=lambda: git(clone, "symbolic-ref", "-q", "HEAD", env=env),
        commit=lambda ref: git(origin, "rev-parse", f"{ref}^{{commit}}", env=env),
    )


NOT_INCLUDED = "Not available yet: the latest release doesn't include it."


def test_get_the_files_checks_the_images_the_deploy_uses():
    # The deploy's images are main.bicep's, at the checked-out release's installer version.
    param = (ROOT / "azure" / "infra" / "main.bicepparam").read_text(encoding="utf-8")
    bicep = (ROOT / "azure" / "infra" / "main.bicep").read_text(encoding="utf-8")
    assert "param imageTag = loadJsonContent('../../installer/package.json').version" in param
    assert "param imageRegistry string = 'ghcr.io/microsoft'" in bicep
    deployed = sorted(re.findall(r"'\$\{imageRegistry\}/([\w-]+):\$\{imageTag\}'", bicep))
    checked = sorted(re.search(r"for i in ([\w -]+); do", GET_FILES).group(1).split())
    assert deployed == checked == ["valuelens-jobs", "valuelens-web"]
    assert "V=$(git show $TAG:installer/package.json | jq -r .version)" in GET_FILES
    assert "https://ghcr.io/v2/microsoft/$i/manifests/$V" in GET_FILES


@pytest.mark.parametrize(
    "url", ["", REPO + "/releases", LATEST + "0.6.6"], ids=["offline", "no-release", "old-release"]
)
def test_get_the_files_stops_if_the_latest_release_does_not_include_it(github, url):
    github.latest(url)
    github.publish("0.6.6")
    r = github.get()
    assert r.returncode != 0
    assert NOT_INCLUDED in r.stdout
    assert not github.record.exists()
    assert github.branch() == "refs/heads/main"
    assert not [c for c in calls(github.state) if "ghcr.io" in c]


@pytest.mark.parametrize("image", ["valuelens-jobs", "valuelens-web"])
def test_get_the_files_stops_until_both_images_are_published(github, image):
    github.latest(LATEST + "9.9.9")
    github.publish("9.9.9", *({"valuelens-jobs", "valuelens-web"} - {image}))
    r = github.get()
    assert r.returncode != 0
    assert f"Not available yet: the {image} 9.9.9 image isn't published." in r.stdout
    assert not github.record.exists()
    assert github.branch() == "refs/heads/main"


def test_get_the_files_uses_the_latest_published_release(github):
    github.latest(LATEST + "9.9.9")
    github.publish("9.9.9")
    r = github.get()
    assert r.returncode == 0, r.stdout + r.stderr
    assert r.stdout.splitlines()[-1] == "Using installer-v9.9.9"
    # The release its images were built from: not the highest tag, and not main.
    assert github.head() == github.commit("installer-v9.9.9")
    assert github.record.read_text(encoding="utf-8") == "// 9.9.9\n"
    assert [c.split()[-1] for c in calls(github.state) if "/manifests/" in c] == [
        "https://ghcr.io/v2/microsoft/valuelens-jobs/manifests/9.9.9",
        "https://ghcr.io/v2/microsoft/valuelens-web/manifests/9.9.9",
    ]


def test_get_the_files_again_keeps_the_record_and_waits_for_the_images(github):
    github.latest(LATEST + "9.9.9")
    github.publish("9.9.9")
    assert github.get().returncode == 0
    filled = "// 9.9.9\nparam webClientId = 'web-1'\n"
    github.record.write_text(filled, encoding="utf-8", newline="\n")

    r = github.get()  # Pasted again: same release, and the IDs are kept.
    assert r.returncode == 0, r.stdout + r.stderr
    assert github.record.read_text(encoding="utf-8") == filled

    github.latest(LATEST + "9.9.10")  # Released, but its images are still being built.
    r = github.get()
    assert r.returncode != 0
    assert "Not available yet: the valuelens-jobs 9.9.10 image isn't published." in r.stdout
    assert github.head() == github.commit("installer-v9.9.9")

    github.publish("9.9.10")
    r = github.get()
    assert r.returncode == 0, r.stdout + r.stderr
    assert r.stdout.splitlines()[-1] == "Using installer-v9.9.10"
    assert github.head() == github.commit("installer-v9.9.10")
    assert github.record.read_text(encoding="utf-8") == filled

    github.release("9.9.11")  # Released after the files were first got.
    github.latest(LATEST + "9.9.11")
    github.publish("9.9.11")
    r = github.get()
    assert r.returncode == 0, r.stdout + r.stderr
    assert github.head() == github.commit("installer-v9.9.11")
    assert github.record.read_text(encoding="utf-8") == filled
