"""Azure by hand: the page's own bash blocks, run against stand-ins.

The blocks come straight from docs/MANUAL-INSTALL.md. az and curl are bash functions that answer
from files, and git clones a local repo, so nothing reaches Azure, Power BI, Graph, GitHub or
GHCR, and nothing real is deleted. The blocks start in a scratch folder, never this checkout.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import textwrap
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
DOC = (ROOT / "docs" / "MANUAL-INSTALL.md").read_text(encoding="utf-8")
TEMPLATE = (ROOT / "azure" / "infra" / "main.bicepparam").read_text(encoding="utf-8")
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


def step_block(lead: str) -> str:
    """The first bash block in the numbered step that starts with `lead`, as pasted."""
    found = re.compile(r"^( +)```bash\n(.*?)^\1```", re.M | re.S).search(DOC, DOC.index(lead))
    assert found, lead
    return textwrap.dedent(found.group(2))


GET_FILES = block("**Get the files.**")
SETUP = block("**Each time Cloud Shell opens**")
STEP_1 = step_block("1. **Deploy**")
REMOVE = block("**Remove.**")

# Stand-ins. Each answers only the exact calls the page makes; anything else is recorded and fails.
# The install is in sub-1, in tenant-1. $STATE/subs lists the subscriptions signed in to, with
# their tenants, and $STATE/current is the one in use.
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
tenant_of() {
  local s t
  while read -r s t; do [ "$s" = "$1" ] && { echo "$t"; return; }; done < "$STATE/subs"
  return 1
}
reaches() {  # Can the user signed in to tenant $1 get to the install's workspace or app $2?
  [ "$1" = tenant-1 ] && [ -e "$STATE/$2" ] && [ ! -e "$STATE/hidden-$2" ]
}
group_at() {  # The resource group $2, as ARM sees it from subscription $1: 0 there, 3 not found.
  tenant_of "$1" >/dev/null || { err SubscriptionNotFound; return; }
  [ -e "$STATE/hidden-rg" ] && { err AuthorizationFailed; return; }
  [ "$1" = sub-1 ] && [ "$2" = "$(cat "$STATE/rg-name")" ] && [ -e "$STATE/rg" ] || return 3
}
az() {
  log "az $*"
  # Without --subscription, a call goes to the subscription in use, and its tenant.
  local sub a=(); sub=$(cat "$STATE/current")
  while [ $# -gt 0 ]; do
    case $1 in
    --subscription|-s|-n|-g|-u|--id)
      [[ $2 == [!-]* ]] || { err "argument $1: expected one argument" 2; return; }
      if [ "$1" = --subscription ]; then sub=$2; else a+=("$1" "$2"); fi; shift 2 ;;
    *) a+=("$1"); shift ;;
    esac
  done
  set -- "${a[@]}"
  local tenant; tenant=$(tenant_of "$sub")
  case "$*" in
  "account set -s "*)
    fails account-set && { err simulated; return; }
    tenant_of "$4" >/dev/null || { err "The subscription of '$4' doesn't exist in cloud 'AzureCloud'."; return; }
    echo "$4" > "$STATE/current" ;;
  "account show --query tenantId -o tsv")
    fails account-show && { err "Please run 'az login' to setup account."; return; }
    echo "$tenant" ;;
  "account show --query id -o tsv")
    fails account-show && { err "Please run 'az login' to setup account."; return; }
    echo "$sub" ;;
  "rest -m DELETE -u https://api.powerbi.com/v1.0/myorg/groups/"*" --resource https://analysis.windows.net/powerbi/api")
    fails workspace-delete && { err simulated; return; }
    [ "$5" = https://api.powerbi.com/v1.0/myorg/groups/ws-1 ] && reaches "$tenant" workspace || { err "Unauthorized(401)"; return; }
    rm "$STATE/workspace" ;;
  "ad app delete --id "*)
    fails "app-delete-$5" && { err simulated; return; }
    reaches "$tenant" "app-$5" || { err "Resource '$5' does not exist or one of its queried reference-property objects are not present." 3; return; }
    rm "$STATE/app-$5" ;;
  "group show -n "*" --query properties.provisioningState -o tsv")
    fails group-show && { err simulated; return; }
    group_at "$sub" "$4"; case $? in 0) cat "$STATE/rg" ;; 3) err ResourceGroupNotFound 3 ;; *) return 1 ;; esac ;;
  "group delete -n "*" --yes --no-wait")
    fails group-delete && { err simulated; return; }
    group_at "$sub" "$4"; case $? in 0) echo Deleting > "$STATE/rg" ;; 3) err ResourceGroupNotFound 3 ;; *) return 1 ;; esac ;;
  "group exists -n "*)
    fails group-exists && { err simulated; return; }
    group_at "$sub" "$4"; case $? in 0) echo true ;; 3) echo false ;; *) return 1 ;; esac ;;
  "deployment group show -g "*" -n analytics-hub --query properties.outputs.identityPrincipalId.value -o tsv")
    fails deployment-show && { err simulated; return; }
    group_at "$sub" "$5"; case $? in 0) echo mi-1 ;; 3) err ResourceGroupNotFound 3 ;; *) return 1 ;; esac ;;
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


def run(
    home: Path, state: Path, *blocks: str, cwd: Path | None = None, prelude: str = ""
) -> subprocess.CompletedProcess:
    """Runs the blocks in bash, as if pasted one after another, with only the stand-ins to call.
    It starts in `cwd`, or else the scratch `state` folder. `prelude` can stand in for a command."""
    guard = home / ".guard"
    guard.mkdir(parents=True, exist_ok=True)
    for name in ("az", "curl"):  # In case a stand-in is ever missed: fail, and say so.
        (guard / name).write_text('#!/bin/sh\necho "$0 $*" >> "$STATE/real"\nexit 97\n', newline="\n")
        (guard / name).chmod(0o755)
    script = state / "run.sh"
    script.write_text(STUBS + prelude + "\n".join(blocks), encoding="utf-8", newline="\n")
    env = {
        **os.environ,
        "HOME": home.as_posix(),
        "STATE": state.as_posix(),
        "PYEXE": Path(sys.executable).as_posix(),
        "AZURE_CONFIG_DIR": (state / "azure-config").as_posix(),
        "GIT_CONFIG_GLOBAL": (home / ".gitconfig").as_posix(),
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CEILING_DIRECTORIES": str(state.parent),  # No repo above the scratch folders.
    }
    result = subprocess.run(
        [BASH, "--noprofile", "--norc", script.as_posix()], cwd=cwd or state,
        env=env, capture_output=True, encoding="utf-8", errors="replace", timeout=180,
    )
    assert not (state / "unexpected").exists(), (state / "unexpected").read_text()
    assert not (state / "real").exists(), (state / "real").read_text()
    return result


def calls(state: Path) -> list[str]:
    log = state / "log"
    return log.read_text(encoding="utf-8").splitlines() if log.exists() else []


# Remove

ALL = {"workspace", "app-web-1", "app-reader-1", "rg"}
# For each: what Remove calls it when it's left, its ID's name in the record, and the ID.
WHAT = {
    "workspace": ("workspace", "workspace", "ws-1"),
    "app-web-1": ("web-app", "webClientId", "web-1"),
    "app-reader-1": ("sql-reader", "sqlReaderClientId", "reader-1"),
}
WHERE = {"tenant": "tenant-1", "subscription": "sub-1", "resourceGroup": "analytics-hub"}
SIGN_IN = (
    "Not removed: you're not signed in where step 1 deployed. Sign in, then paste this again: "
    "az login --use-device-code --tenant tenant-1"
)
NO_RECORD = "Not removed: azure/infra/my.bicepparam doesn't say where step 1 deployed."


@pytest.fixture
def install(tmp_path):
    """A finished install in sub-1, in tenant-1: its record, and the workspace, two apps and
    resource group it names. Signed in to sub-1, and to sub-2 in tenant-2."""
    home, state = tmp_path / "home", tmp_path / "state"
    infra = home / "AnalyticsHub-Dashboard" / "azure" / "infra"
    infra.mkdir(parents=True)
    state.mkdir()
    text = TEMPLATE
    for name, value in (*WHERE.items(), *((key, i) for _, key, i in WHAT.values())):
        old = re.search(rf"^(?:param|var) {name} = ''", text, re.M)
        assert old and text.count(old.group()) == 1, name
        text = text.replace(old.group(), f"{old.group()[:-2]}'{value}'")
    record = infra / "my.bicepparam"
    record.write_text(text, encoding="utf-8", newline="\n")
    for name in ("workspace", "app-web-1", "app-reader-1"):
        (state / name).touch()
    for name, value in (
        ("rg", "Succeeded"), ("rg-name", "analytics-hub"),
        ("subs", "sub-1 tenant-1\nsub-2 tenant-2"), ("current", "sub-1"),
    ):
        (state / name).write_text(value + "\n", newline="\n")
    return SimpleNamespace(home=home, state=state, record=record, text=text)


def remove(inst) -> subprocess.CompletedProcess:
    return run(inst.home, inst.state, SETUP, REMOVE)


def left(inst) -> set[str]:
    return {n for n in ALL if (inst.state / n).exists()}


def recorded(inst) -> dict[str, str]:
    text = inst.record.read_text(encoding="utf-8")
    return dict(re.findall(r"^(?:param|var) (\w+) = '([^']*)'", text, re.M))


def resource_calls(state: Path) -> list[str]:
    """Calls to Power BI, Graph or the resource group."""
    return [c for c in calls(state) if c.startswith(("az rest ", "az ad ", "az group "))]


def group_deletes(state: Path, name: str = "analytics-hub") -> list[str]:
    return [c for c in calls(state) if c.startswith(f"az group delete -n {name} ")]


def test_remove_deletes_it_all_then_waits_for_the_resource_group(install):
    r = remove(install)
    assert r.returncode != 0
    assert "Not removed yet: resource-group. Paste this again in a few minutes." in r.stdout
    assert left(install) == {"rg"}
    assert (install.state / "rg").read_text().strip() == "Deleting"
    # Each ID goes once its own delete succeeds. Where it's deployed stays, for the next paste.
    values = recorded(install)
    assert {k: values[k] for k in WHERE} == WHERE
    assert [values[key] for _, key, _ in WHAT.values()] == ["", "", ""]

    # Still deleting: nothing is asked again, and the record stays.
    r = remove(install)
    assert r.returncode != 0
    assert "Not removed yet: resource-group." in r.stdout
    assert install.record.exists()
    assert len(group_deletes(install.state)) == 1
    assert [c for c in calls(install.state) if c.startswith(("az rest ", "az ad "))] == [
        "az rest -m DELETE -u https://api.powerbi.com/v1.0/myorg/groups/ws-1"
        " --resource https://analysis.windows.net/powerbi/api",
        "az ad app delete --id web-1",
        "az ad app delete --id reader-1",
    ]

    # Gone: only now does the record go.
    (install.state / "rg").unlink()
    r = remove(install)
    assert r.returncode == 0, r.stdout + r.stderr
    assert r.stdout.splitlines()[-1] == "Removed"
    assert not install.record.exists()
    assert len(group_deletes(install.state)) == 1

    # Pasted once more: with no record, there's nothing it can act on.
    before = len(calls(install.state))
    r = remove(install)
    assert r.returncode != 0
    assert NO_RECORD in r.stdout
    assert [c for c in calls(install.state)[before:] if c.startswith(("az account set", "az rest ", "az ad ", "az group "))] == []


def test_remove_keeps_the_record_when_every_delete_fails(install):
    for call in ("workspace-delete", "app-delete-web-1", "app-delete-reader-1", "group-show",
                 "group-delete", "group-exists"):
        (install.state / f"fail-{call}").touch()
    r = remove(install)
    assert r.returncode != 0
    assert "Not removed yet: workspace web-app sql-reader resource-group." in r.stdout
    assert "Removed" not in r.stdout
    assert install.record.read_text(encoding="utf-8") == install.text
    assert left(install) == ALL


def test_remove_keeps_the_id_it_could_not_delete_then_retries_only_that(install):
    (install.state / "fail-app-delete-reader-1").touch()
    r = remove(install)
    assert r.returncode != 0
    assert "Not removed yet: sql-reader resource-group." in r.stdout
    values = recorded(install)
    assert (values["workspace"], values["webClientId"], values["sqlReaderClientId"]) == ("", "", "reader-1")
    assert left(install) == {"app-reader-1", "rg"}

    # The cause is fixed and Azure has finished with the group: pasting again finishes the job.
    (install.state / "fail-app-delete-reader-1").unlink()
    (install.state / "rg").unlink()
    before = len(calls(install.state))
    r = remove(install)
    assert r.returncode == 0, r.stdout + r.stderr
    assert r.stdout.splitlines()[-1] == "Removed"
    again = calls(install.state)[before:]
    assert [c for c in again if c.startswith(("az rest ", "az ad "))] == ["az ad app delete --id reader-1"]
    assert not install.record.exists()
    assert left(install) == set()


def test_remove_switches_to_step_1s_subscription_before_it_deletes_anything(install):
    # In use: sub-2, in tenant-2, where Power BI and Graph can't see the install.
    (install.state / "current").write_text("sub-2\n", newline="\n")
    r = remove(install)
    assert "Not removed yet: resource-group." in r.stdout
    assert left(install) == {"rg"}
    log = calls(install.state)
    switch = log.index("az account set -s sub-1")
    assert all(i > switch for i, c in enumerate(log) if c.startswith(("az rest ", "az ad ", "az group ")))

    (install.state / "rg").unlink()
    r = remove(install)
    assert r.returncode == 0, r.stdout + r.stderr
    assert r.stdout.splitlines()[-1] == "Removed"
    assert not install.record.exists()
    assert left(install) == set()


@pytest.mark.parametrize(
    "signed_in",
    [None, "sub-2 tenant-2", "sub-1 tenant-3\nsub-2 tenant-2", "sub-3 tenant-1\nsub-2 tenant-2"],
    ids=["signed-out", "other-tenant-only", "subscription-moved-tenant", "subscription-out-of-reach"],
)
def test_remove_deletes_nothing_unless_signed_in_where_step_1_deployed(install, signed_in):
    (install.state / "current").write_text("sub-2\n", newline="\n")
    if signed_in:
        (install.state / "subs").write_text(signed_in + "\n", newline="\n")
    else:
        (install.state / "fail-all").touch()
    r = remove(install)
    assert r.returncode != 0
    assert SIGN_IN in r.stdout
    assert resource_calls(install.state) == []
    assert install.record.read_text(encoding="utf-8") == install.text
    assert left(install) == ALL


@pytest.mark.parametrize("current", ["sub-1", "sub-2"])
@pytest.mark.parametrize(
    "hidden",
    [("workspace",), ("app-web-1",), ("app-reader-1",), ("workspace", "app-web-1", "app-reader-1")],
    ids=["workspace", "web-app", "sql-reader", "all"],
)
def test_remove_never_takes_what_it_cannot_get_to_as_deleted(install, hidden, current):
    # Signed in as someone else, or their access was taken away: it's still there.
    for name in hidden:
        (install.state / f"hidden-{name}").touch()
    (install.state / "current").write_text(current + "\n", newline="\n")
    remove(install)
    (install.state / "rg").unlink()  # Azure has finished with the resource group.
    for _ in range(2):
        r = remove(install)
        assert r.returncode != 0
        assert f"Not removed yet: {' '.join(WHAT[n][0] for n in hidden)}." in r.stdout
        assert "Removed" not in r.stdout
        assert left(install) == set(hidden)
        values = recorded(install)
        assert [values[WHAT[n][1]] for n in hidden] == [WHAT[n][2] for n in hidden]


def test_remove_cannot_tell_already_deleted_from_out_of_reach_so_keeps_the_id(install):
    (install.state / "workspace").unlink()  # Deleted some other way.
    remove(install)
    (install.state / "rg").unlink()
    r = remove(install)
    assert r.returncode != 0
    assert "Not removed yet: workspace." in r.stdout
    assert recorded(install)["workspace"] == "ws-1"


def test_remove_keeps_the_record_while_it_cannot_see_the_resource_group(install):
    (install.state / "hidden-rg").touch()  # Access taken away: it's still there.
    for _ in range(2):
        r = remove(install)
        assert r.returncode != 0
        assert "Not removed yet: resource-group." in r.stdout
    assert group_deletes(install.state) == []
    assert left(install) == {"rg"}
    assert recorded(install)["resourceGroup"] == "analytics-hub"


def test_remove_counts_a_failed_check_as_not_removed(install):
    remove(install)
    (install.state / "rg").unlink()
    (install.state / "fail-group-exists").touch()
    r = remove(install)
    assert r.returncode != 0
    assert "Not removed yet: resource-group." in r.stdout
    assert install.record.exists()


def test_remove_uses_the_resource_group_step_1_recorded(install):
    # Deployed as my-rg. The setup block pasted now has the default, analytics-hub.
    text = install.text.replace("var resourceGroup = 'analytics-hub'", "var resourceGroup = 'my-rg'")
    install.record.write_text(text, encoding="utf-8", newline="\n")
    (install.state / "rg-name").write_text("my-rg\n", newline="\n")
    r = remove(install)
    assert r.returncode != 0
    assert "Not removed yet: resource-group." in r.stdout
    assert len(group_deletes(install.state, "my-rg")) == 1
    assert group_deletes(install.state) == []

    (install.state / "rg").unlink()
    r = remove(install)
    assert r.returncode == 0, r.stdout + r.stderr
    assert r.stdout.splitlines()[-1] == "Removed"


@pytest.mark.parametrize(
    "missing, failing",
    [("tenant", None), ("tenant", "account-show"), ("subscription", None), ("resourceGroup", None)],
)
def test_remove_deletes_nothing_if_the_record_does_not_say_where_step_1_deployed(
    install, missing, failing
):
    text = install.text.replace(f"var {missing} = '{WHERE[missing]}'", f"var {missing} = ''")
    assert text != install.text
    install.record.write_text(text, encoding="utf-8", newline="\n")
    if failing:
        (install.state / f"fail-{failing}").touch()
    r = remove(install)
    assert r.returncode != 0
    assert NO_RECORD in r.stdout
    assert resource_calls(install.state) == []
    assert install.record.read_text(encoding="utf-8") == text
    assert left(install) == ALL


def test_step_1_records_where_it_deploys_before_it_deploys(install):
    record_where, deploy = STEP_1.split("for p in", 1)
    assert "az group create" in deploy and "az deployment group create" in deploy
    install.record.write_text(TEMPLATE, encoding="utf-8", newline="\n")
    (install.state / "subs").write_text("sub-9 tenant-9\n", newline="\n")
    (install.state / "current").write_text("sub-9\n", newline="\n")
    setup = SETUP.replace("RG=analytics-hub;", "RG=my-rg;")
    assert setup != SETUP
    r = run(install.home, install.state, setup, record_where)
    assert r.returncode == 0, r.stdout + r.stderr
    expected = TEMPLATE
    for name, value in (("tenant", "tenant-9"), ("subscription", "sub-9"), ("resourceGroup", "my-rg")):
        expected = expected.replace(f"var {name} = ''", f"var {name} = '{value}'")
    assert install.record.read_text(encoding="utf-8") == expected


# Get the files


def git(cwd: Path, *args: str, env: dict) -> str:
    return subprocess.run(
        ["git", "-C", str(cwd), *args], env=env, check=True, capture_output=True, encoding="utf-8"
    ).stdout.strip()


def curls(state: Path, since: int = 0) -> list[str]:
    """The URLs curl was asked for, after the first `since` calls."""
    return [c.split()[-1] for c in calls(state)[since:] if c.startswith("curl ")]


# Stand-ins for a command that fails. Each one fails only where the block uses it.
CLONE_FAILS = (
    'git() { command git "$@" || return; [ "$1" != clone ] ||'
    ' { echo "warning: Clone succeeded, but checkout failed." >&2; return 128; }; }\n'
)
CD_FAILS = (
    'cd() { [ "$1" != "$HOME/AnalyticsHub-Dashboard" ] ||'
    ' { echo "cd: $1: Permission denied" >&2; return 1; }; builtin cd "$@"; }\n'
)
CHECKOUT_FAILS = (
    'git() { [ "$1" != checkout ] ||'
    ' { echo "error: unable to unlink old file: Permission denied" >&2; return 1; }; command git "$@"; }\n'
)
COPY_FAILS = 'cp() { echo "cp: cannot create regular file: Disk quota exceeded" >&2; return 1; }\n'


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

    def own():
        """A checkout of your own, where a paste might start: on a branch, with the releases'
        tags cached. Returns it, and a way to see if anything in it changed."""
        path = tmp_path / "elsewhere"
        git(tmp_path, "clone", "-q", REPO, path.name, env=env)
        git(path, "checkout", "-q", "-b", "work", env=env)
        return path, lambda: (
            git(path, "rev-parse", "--symbolic-full-name", "HEAD", env=env),
            git(path, "rev-parse", "HEAD", env=env),
            git(path, "status", "--porcelain", "--untracked-files=all", env=env),
        )

    clone = home / "AnalyticsHub-Dashboard"
    return SimpleNamespace(
        state=state, clone=clone, record=clone / "azure" / "infra" / "my.bicepparam",
        env=env, release=release, publish=publish, own=own,
        latest=lambda url: (state / "latest").write_text(url, encoding="utf-8"),
        get=lambda cwd=None, prelude="": run(home, state, GET_FILES, cwd=cwd, prelude=prelude),
        # GitHub can't be reached. Use commit() before this, not after.
        unreachable=lambda: origin.rename(origin.with_name("offline")),
        head=lambda: git(clone, "rev-parse", "HEAD", env=env),
        branch=lambda: git(clone, "symbolic-ref", "-q", "HEAD", env=env),
        commit=lambda ref: git(origin, "rev-parse", f"{ref}^{{commit}}", env=env),
    )


NOT_INCLUDED = "Not available yet: the latest release doesn't include it."


def test_get_the_files_checks_the_images_the_deploy_uses():
    # The deploy's images are main.bicep's, at the checked-out release's installer version.
    bicep = (ROOT / "azure" / "infra" / "main.bicep").read_text(encoding="utf-8")
    assert "param imageTag = loadJsonContent('../../installer/package.json').version" in TEMPLATE
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
    # It asks for the latest release, and nothing else: no image checks.
    assert curls(github.state) == [REPO + "/releases/latest"]


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


# If git can't get the files, the block stops there: before it looks up the release, and before
# it checks anything out or copies anything, wherever it was pasted.


def test_get_the_files_stops_if_git_cannot_clone(github):
    github.latest(LATEST + "9.9.9")
    github.publish("9.9.9")
    r = github.get(prelude=CLONE_FAILS)  # The folder is made, but the clone fails.
    assert r.returncode != 0
    assert r.stdout == ""
    assert curls(github.state) == []
    assert github.clone.exists() and not github.record.exists()


def test_get_the_files_does_nothing_where_it_was_pasted_if_git_cannot_clone(github):
    # Offline, pasted in a checkout of your own with a good release cached. Without the clone
    # there's no folder to change to, and nothing must happen where you are instead.
    caller, snapshot = github.own()
    before = snapshot()
    github.latest(LATEST + "9.9.9")
    github.publish("9.9.9")
    github.unreachable()
    r = github.get(cwd=caller)
    assert r.returncode != 0
    assert r.stdout == ""
    assert curls(github.state) == []
    assert snapshot() == before
    assert not (caller / "azure" / "infra" / "my.bicepparam").exists()
    assert not github.clone.exists()


def test_get_the_files_does_nothing_where_it_was_pasted_if_it_cannot_change_folder(github):
    github.latest(LATEST + "9.9.9")
    github.publish("9.9.9")
    assert github.get().returncode == 0
    head = github.head()
    caller, snapshot = github.own()
    before = snapshot()
    since = len(calls(github.state))
    r = github.get(cwd=caller, prelude=CD_FAILS)
    assert r.returncode != 0
    assert r.stdout == ""
    assert curls(github.state, since) == []
    assert snapshot() == before
    assert not (caller / "azure" / "infra" / "my.bicepparam").exists()
    assert github.head() == head


def test_get_the_files_stops_if_git_cannot_fetch(github):
    # A newer release is out, and its tag is already here, but fetching fails: nothing is used.
    github.latest(LATEST + "9.9.9")
    github.publish("9.9.9")
    assert github.get().returncode == 0
    head = github.head()
    github.latest(LATEST + "9.9.10")
    github.publish("9.9.10")
    github.unreachable()
    since = len(calls(github.state))
    r = github.get()
    assert r.returncode != 0
    assert r.stdout == ""
    assert curls(github.state, since) == []
    assert github.head() == head
    assert github.record.read_text(encoding="utf-8") == "// 9.9.9\n"


@pytest.mark.parametrize("prelude", [CHECKOUT_FAILS, COPY_FAILS], ids=["checkout", "copy"])
def test_get_the_files_says_using_only_once_it_has_the_files(github, prelude):
    github.latest(LATEST + "9.9.9")
    github.publish("9.9.9")
    r = github.get(prelude=prelude)
    assert r.returncode != 0
    assert "Using" not in r.stdout
    assert not github.record.exists()
