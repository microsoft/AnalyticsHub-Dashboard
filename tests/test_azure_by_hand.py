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
STEP_2 = step_block("2. **Register the apps:**")
STEP_4 = step_block("4. **Publish the report.**")
REMOVE = block("**Remove.**")
# The template's last line. Get the files uses a record only if it has it. Records already made
# end with it, so never change it.
COMPLETE = "// Keep this line last: it shows this file is complete."

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
recorded() {  # What the record says for $1.
  command sed -n -E "s/^(param|var) $1 = '([^']*)'.*/\2/p" "$HOME/AnalyticsHub-Dashboard/azure/infra/my.bicepparam" 2>/dev/null
}
scoped() {  # Before a deploy: has step 1 saved this tenant, subscription and resource group ($1, or any)?
  local g; g=$(recorded resourceGroup)
  [ -n "$g" ] && [ "$g" = "${1:-$g}" ] && [ "$(recorded tenant)" = "$tenant" ] &&
    [ "$(recorded subscription)" = "$sub" ] && return
  echo "az call before step 1 saved where it deploys: $tenant $sub ${1:-?}" >> "$STATE/unexpected"; return 99
}
saved() {  # Before setting up $1: is it saved, as one of the names after it?
  local id=$1 k; shift
  for k; do [ -n "$id" ] && [ "$(recorded "$k")" = "$id" ] && return; done
  echo "az call for '$id' before it was saved as $*" >> "$STATE/unexpected"; return 99
}
made() {  # Makes a new $1 (web or reader, an app; ws, the workspace) and prints its ID.
  local n; n=$(( $(cat "$STATE/made-$1" 2>/dev/null || echo 0) + 1 ))
  echo "$n" > "$STATE/made-$1"
  if [ "$1" = ws ]; then touch "$STATE/workspace"; else touch "$STATE/app-$1-$n"; fi
  echo "$1-$n"
}
sleep() { log "sleep $*"; }
rm -f "$STATE/web-app.json"  # Step 2 writes it. See run().
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
  "deployment group show -g "*" -n analytics-hub --query properties.outputs."*".value -o tsv")
    fails deployment-show && { err simulated; return; }
    group_at "$sub" "$5"; case $? in 0) ;; 3) err ResourceGroupNotFound 3; return ;; *) return 1 ;; esac
    case $9 in
    properties.outputs.identityPrincipalId.value) echo mi-1 ;;
    properties.outputs.webFqdn.value) echo app.example.test ;;
    properties.outputs.sqlServerFqdn.value) echo sql.example.test ;;
    properties.outputs.sqlDatabaseName.value) echo db-1 ;;
    *) printf '%s\n' "az $*" >> "$STATE/unexpected"; err "unexpected output" 99 ;;
    esac ;;
  # Step 1. Each deploy call checks step 1 has already saved where it's deploying.
  "provider register -n Microsoft."*" --wait")
    scoped || return; fails provider-register && { err simulated; return; }; : ;;
  "group create -n "*" -l uksouth -o none")
    scoped "$4" || return; fails group-create && { err simulated; return; }
    echo "$4" > "$STATE/rg-name"; [ -e "$STATE/rg" ] || echo Succeeded > "$STATE/rg" ;;
  "deployment group create -g "*" -n analytics-hub -p azure/infra/my.bicepparam --query properties.provisioningState -o tsv")
    scoped "$5" || return; fails deployment-create && { err simulated; return; }
    group_at "$sub" "$5" || { err ResourceGroupNotFound 3; return; }
    echo Succeeded ;;
  # Step 2. The SQL reader is made only once the web app is saved, and each app is set up only
  # once it's saved.
  "rest -m POST -u https://graph.microsoft.com/v1.0/applications -b @$STATE/web-app.json --query appId -o tsv")
    fails web-create && { err simulated; return; }
    grep -q '"https://app.example.test/' "$STATE/web-app.json" || { err "Invalid value for redirectUris"; return; }
    made web ;;
  'rest -m POST -u https://graph.microsoft.com/v1.0/applications -b {"displayName": "Analytics Hub SQL Reader"} --query appId -o tsv')
    [ -n "$(recorded webClientId)" ] && [ -n "$(recorded webAppIdUri)" ] ||
      { echo "SQL reader made before the web app was saved" >> "$STATE/unexpected"; return 99; }
    fails reader-create && { err simulated; return; }
    made reader ;;
  "ad app update --id "*" --identifier-uris "*)
    saved "$5" webClientId || return ;;
  "ad sp create --id "*" -o none")
    saved "$5" webClientId sqlReaderClientId || return
    [ ! -e "$STATE/sp-$5" ] || { err "Another object with the same value for property servicePrincipalNames already exists."; return; }
    touch "$STATE/sp-$5" ;;
  "ad app federated-credential create --id "*" --parameters "*" -o none")
    saved "$6" webClientId || return
    [ ! -e "$STATE/fic-$6" ] || { err "FederatedIdentityCredential with name managed-identity already exists."; return; }
    touch "$STATE/fic-$6" ;;
  # Step 4. The workspace is set up only once it's saved.
  'rest -m POST -u https://api.powerbi.com/v1.0/myorg/groups?workspaceV2=True --resource https://analysis.windows.net/powerbi/api -b {"name": "Analytics Hub (Azure)"} --query id -o tsv')
    fails workspace-create && { err simulated; return; }
    made ws ;;
  "rest -m POST -u https://api.powerbi.com/v1.0/myorg/groups/"*"/users --resource https://analysis.windows.net/powerbi/api -b "*" -o none")
    local w=${5#https://api.powerbi.com/v1.0/myorg/groups/}
    saved "${w%/users}" workspace || return ;;
  "rest -u https://api.powerbi.com/v1.0/myorg/groups/ws-1/datasets --resource https://analysis.windows.net/powerbi/api --query value[?name=='Analytics Hub Model'].id -o tsv")
    echo model-1 ;;
  "rest -u https://api.powerbi.com/v1.0/myorg/groups/ws-1/datasets --resource https://analysis.windows.net/powerbi/api --query value[?name=='Analytics Hub Consumption Model'].id -o tsv")
    echo cmodel-1 ;;
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
    # Step 2's file goes in this scratch folder, not the shared /tmp, so tests can run side by side.
    # It's the only change made to the blocks.
    pasted_text = "\n".join(blocks).replace("/tmp/web-app.json", '"$STATE/web-app.json"')
    script.write_text(STUBS + prelude + pasted_text, encoding="utf-8", newline="\n")
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


def fill(text: str, values: dict[str, str]) -> str:
    """`text`, with `values` put in it as put does: each one's whole line is rewritten. A value is
    left bare only for a setting the template has as true, false or a number. All else is text."""
    for name, value in values.items():
        typed = re.search(rf"^(?:// )?param {name} = (?:true|false|[0-9]+)\b", TEMPLATE, re.M)
        v = value if typed and re.fullmatch(r"true|false|[0-9]+", value) else f"'{value}'"
        text, n = re.subn(
            rf"^(?:// )?(param|var) {name} = .*$", lambda m: f"{m[1]} {name} = {v}", text, flags=re.M
        )
        assert n == 1, name
    return text


@pytest.fixture
def install(tmp_path):
    """A finished install in sub-1, in tenant-1: its record, and the workspace, two apps and
    resource group it names. Signed in to sub-1, and to sub-2 in tenant-2."""
    home, state = tmp_path / "home", tmp_path / "state"
    clone = home / "AnalyticsHub-Dashboard"
    infra = clone / "azure" / "infra"
    infra.mkdir(parents=True)
    (clone / "fabric").mkdir()
    state.mkdir()
    for name in ("main.bicepparam", "web-app-registration.json"):  # put reads the template.
        shutil.copy(ROOT / "azure" / "infra" / name, infra)
    (clone / "fabric" / "ValueLens - Fabric.pbit").write_bytes(b"report")
    text = fill(TEMPLATE, {**WHERE, **{key: i for _, key, i in WHAT.values()}})
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


# Steps 1, 2 and 4, and put. Each block runs whole. The stand-ins fail any call made before what
# it needs is in the record: a deploy before where it deploys, and an app or the workspace being
# set up before its ID.

WEB_IDS = {
    "webClientId": "web-1",
    "webAppIdUri": "api://app.example.test/web-1",
    "sqlReaderClientId": "reader-1",
}
DEPLOY = [  # Step 1's calls that change Azure, in order.
    *(f"az provider register -n Microsoft.{p} --wait"
      for p in re.search(r"for p in ([\w ]+); do", STEP_1)[1].split()),
    "az group create -n analytics-hub -l uksouth -o none",
    "az deployment group create -g analytics-hub -n analytics-hub -p azure/infra/my.bicepparam"
    " --query properties.provisioningState -o tsv",
]
SET_UP = [  # Step 2's calls that set up the apps.
    "az ad app update --id web-1 --identifier-uris api://app.example.test/web-1",
    "az ad sp create --id web-1 -o none",
    "az ad sp create --id reader-1 -o none",
    'az ad app federated-credential create --id web-1 --parameters {"name": "managed-identity",'
    ' "issuer": "https://login.microsoftonline.com/tenant-1/v2.0", "subject": "mi-1",'
    ' "audiences": ["api://AzureADTokenExchange"]} -o none',
]
MEMBER = (  # Step 4's call that sets up the workspace.
    "az rest -m POST -u https://api.powerbi.com/v1.0/myorg/groups/ws-1/users"
    ' --resource https://analysis.windows.net/powerbi/api -b {"identifier": "mi-1",'
    ' "principalType": "App", "groupUserAccessRight": "Member"} -o none'
)
NOT_SAVED = "Not saved in azure/infra/my.bicepparam: "

# sed, failing as when the disk is full, where the test says: fail-write, every write to the
# record; fail-write-<name>, the writes of <name>; fail-silently-write, every write, though sed
# says it worked; fail-registration, writing step 2's registration, part-way through.
WRITE_FAILS = r"""
sed() {
  local re='\) ([A-Za-z]+) = '
  if [ "$1" = -i ]; then
    [[ $3 =~ $re ]]
    if fails write || fails "write-${BASH_REMATCH[1]}"; then
      echo "sed: couldn't open temporary file azure/infra/sedX4bQ2z: Disk quota exceeded" >&2; return 4
    fi
    [ ! -e "$STATE/fail-silently-write" ] || return 0
  elif [[ $1 == "s/{{fqdn}}/"* ]] && fails registration; then
    command sed "$@" | head -n 3; echo "sed: couldn't write 9 items to stdout: Disk quota exceeded" >&2; return 4
  fi
  command sed "$@"
}
"""
# Between two pastes in one shell: the cause is fixed. The record as the first paste left it, if
# there is one, goes to $STATE/after-first.
FIXED = (
    'rm -f "$STATE"/fail-*; log "-- fixed"\n'
    'command cp ~/AnalyticsHub-Dashboard/azure/infra/my.bicepparam "$STATE/after-first" 2>/dev/null\n'
)


def at_step(inst, step: int) -> str:
    """Takes the install back to just before step 1, 2 or 4: the record so far, and only what the
    steps before it made. Returns the record."""
    for name in {1: ALL, 2: ALL - {"rg"}, 4: {"workspace"}}[step]:
        (inst.state / name).unlink()
    text = fill(TEMPLATE, {1: {}, 2: WHERE, 4: {**WHERE, **WEB_IDS}}[step])
    inst.record.write_text(text, encoding="utf-8", newline="\n")
    return text


def checked(block: str) -> str:
    """The block, then its exit status, so the same shell can paste it again."""
    return block + 'echo "== exit $?"\n'


def pasted(r) -> list[tuple[int, str]]:
    """Each checked() block's exit status, and what it printed."""
    parts = re.split(r"^== exit (\d+)\n", r.stdout, flags=re.M)
    return [(int(code), out) for out, code in zip(parts[::2], parts[1::2])]


def pastes(state: Path) -> tuple[list[str], list[str]]:
    """The calls made before FIXED, and after it."""
    log = calls(state)
    return log[: log.index("-- fixed")], log[log.index("-- fixed") + 1 :]


def after_first(inst) -> str | None:
    path = inst.state / "after-first"
    return path.read_text(encoding="utf-8") if path.exists() else None


def deploying(log: list[str]) -> list[str]:
    return [c for c in log if c.startswith(("az provider ", "az group create ", "az deployment group create "))]


def setting_up(log: list[str]) -> list[str]:
    return [c for c in log if c.startswith(("az ad ", "az rest -m POST -u https://api.powerbi.com/v1.0/myorg/groups/"))]


def made(state: Path) -> dict[str, int]:
    """How many web apps, SQL readers and workspaces the steps have made."""
    return {k: int((state / f"made-{k}").read_text()) for k in ("web", "reader", "ws") if (state / f"made-{k}").exists()}


def test_step_1_saves_where_it_deploys_before_it_changes_anything(install):
    at_step(install, 1)
    for _ in range(2):  # Pasted again in the same place, it deploys again.
        r = run(install.home, install.state, SETUP, STEP_1)
        assert r.returncode == 0, r.stdout + r.stderr
        assert r.stdout.splitlines() == [
            "var tenant = 'tenant-1'", "var subscription = 'sub-1'", "var resourceGroup = 'analytics-hub'",
            "Succeeded",
        ]
        assert install.record.read_text(encoding="utf-8") == fill(TEMPLATE, WHERE)
    assert deploying(calls(install.state)) == DEPLOY * 2


@pytest.mark.parametrize(
    "failing, saved",
    [
        ("account-show", {}),
        ("write", {}),
        ("silently-write", {}),
        ("write-subscription", {"tenant": "tenant-1"}),
        ("write-resourceGroup", {"tenant": "tenant-1", "subscription": "sub-1"}),
    ],
)
def test_step_1_changes_nothing_until_it_has_saved_where_it_deploys(install, failing, saved):
    at_step(install, 1)
    (install.state / f"fail-{failing}").touch()
    r = run(install.home, install.state, SETUP, checked(STEP_1), FIXED, checked(STEP_1), prelude=WRITE_FAILS)
    (code, out), (again, out_again) = pasted(r)
    first, then = pastes(install.state)
    # It stops, says why, and changes nothing. The shell stays open, to paste it again.
    assert code != 0
    if failing == "account-show":
        assert out == "" and "ERROR: Please run 'az login' to setup account." in r.stderr
    else:
        name = failing[len("write-"):] if failing.startswith("write-") else "tenant"
        assert out.splitlines()[-1] == f"{NOT_SAVED}{name} = '{WHERE[name]}'"
    assert deploying(first) == []
    assert after_first(install) == fill(TEMPLATE, saved)
    # Fixed, and pasted again: it saves the rest, then deploys.
    assert again == 0, r.stdout + r.stderr
    assert out_again.splitlines()[-1] == "Succeeded"
    assert deploying(then) == DEPLOY
    assert install.record.read_text(encoding="utf-8") == fill(TEMPLATE, WHERE)


@pytest.mark.parametrize("missing", ["record", "clone"])
def test_step_1_deploys_nothing_without_the_record(install, missing):
    # Without the clone, the setup block's cd fails and the block runs where it was pasted.
    if missing == "record":
        install.record.unlink()
    else:
        shutil.rmtree(install.home / "AnalyticsHub-Dashboard")
    r = run(install.home, install.state, SETUP, STEP_1)
    assert r.returncode != 0
    assert r.stdout.splitlines() == [NOT_SAVED + "tenant = 'tenant-1'"]
    assert deploying(calls(install.state)) == []
    assert not install.record.exists() and not (install.state / "azure").exists()


@pytest.mark.parametrize(
    "failing, calls_made",
    [("provider-register", 1), ("group-create", len(DEPLOY) - 1), ("deployment-create", len(DEPLOY))],
)
def test_step_1_stops_at_the_first_call_that_fails(install, failing, calls_made):
    at_step(install, 1)
    (install.state / f"fail-{failing}").touch()
    r = run(install.home, install.state, SETUP, checked(STEP_1), FIXED, checked(STEP_1))
    (code, out), (again, out_again) = pasted(r)
    first, then = pastes(install.state)
    assert code != 0 and "Succeeded" not in out
    assert deploying(first) == DEPLOY[:calls_made]
    assert again == 0, r.stdout + r.stderr
    assert out_again.splitlines()[-1] == "Succeeded"
    assert deploying(then) == DEPLOY
    assert install.record.read_text(encoding="utf-8") == fill(TEMPLATE, WHERE)


@pytest.mark.parametrize(
    "current, rg, says",
    [
        ("sub-2", "analytics-hub", "tenant tenant-1, not tenant-2"),
        ("sub-3", "analytics-hub", "subscription sub-1, not sub-3"),
        ("sub-1", "my-rg", "resourceGroup analytics-hub, not my-rg"),
    ],
    ids=["other-tenant", "other-subscription", "other-resource-group"],
)
def test_step_1_deploys_nowhere_else_with_the_same_record(install, current, rg, says):
    # The record is how Remove finds what step 1 deployed, so it's never pointed somewhere else.
    text = at_step(install, 2)
    (install.state / "subs").write_text("sub-1 tenant-1\nsub-2 tenant-2\nsub-3 tenant-1\n", newline="\n")
    (install.state / "current").write_text(current + "\n", newline="\n")
    r = run(install.home, install.state, SETUP.replace("RG=analytics-hub;", f"RG={rg};"), STEP_1)
    assert r.returncode != 0
    assert r.stdout.splitlines() == [f"Not deployed: azure/infra/my.bicepparam is for {says}."]
    assert deploying(calls(install.state)) == []
    assert install.record.read_text(encoding="utf-8") == text


@pytest.mark.parametrize("rg", ["123", "true"])
def test_step_1_saves_a_resource_group_called_123_or_true_as_a_name(install, rg):
    # Saved as text, the name reads back: for step 1 pasted again, and for Remove.
    at_step(install, 1)
    r = run(install.home, install.state, SETUP.replace("RG=analytics-hub;", f"RG={rg};"), STEP_1)
    assert r.returncode == 0, r.stdout + r.stderr
    assert r.stdout.splitlines() == [
        "var tenant = 'tenant-1'", "var subscription = 'sub-1'", f"var resourceGroup = '{rg}'", "Succeeded",
    ]
    assert recorded(install)["resourceGroup"] == rg
    assert deploying(calls(install.state)) == [
        c.replace("-n analytics-hub -l", f"-n {rg} -l").replace("-g analytics-hub", f"-g {rg}") for c in DEPLOY
    ]

    # Pasted again for another group, it won't deploy there: the record keeps the first one.
    text, before = install.record.read_text(encoding="utf-8"), len(calls(install.state))
    r = run(install.home, install.state, SETUP, STEP_1)
    assert r.returncode != 0
    assert r.stdout.splitlines() == [
        f"Not deployed: azure/infra/my.bicepparam is for resourceGroup {rg}, not analytics-hub."
    ]
    assert deploying(calls(install.state)[before:]) == []
    assert install.record.read_text(encoding="utf-8") == text

    # Remove finds it, and keeps the record until it's gone.
    r = remove(install)
    assert r.returncode != 0 and NO_RECORD not in r.stdout
    assert "Not removed yet: resource-group." in r.stdout
    assert group_deletes(install.state, rg) == [f"az group delete -n {rg} --yes --no-wait"]
    assert install.record.read_text(encoding="utf-8") == text
    (install.state / "rg").unlink()
    r = remove(install)
    assert r.returncode == 0, r.stdout + r.stderr
    assert r.stdout.splitlines()[-1] == "Removed"
    assert not install.record.exists()


def test_step_2_saves_each_app_before_it_sets_it_up(install):
    text = at_step(install, 2)
    r = run(install.home, install.state, SETUP, STEP_2)
    assert r.returncode == 0, r.stdout + r.stderr
    assert install.record.read_text(encoding="utf-8") == fill(text, WEB_IDS)
    assert setting_up(calls(install.state)) == SET_UP
    assert made(install.state) == {"web": 1, "reader": 1}

    # Pasted again in a new shell, it uses the apps it saved. "Already exists" errors are fine.
    r = run(install.home, install.state, SETUP, STEP_2)
    assert "already exists" in r.stderr
    assert install.record.read_text(encoding="utf-8") == fill(text, WEB_IDS)
    assert made(install.state) == {"web": 1, "reader": 1}


WEB_SAVED = {"webClientId": "web-1", "webAppIdUri": "api://app.example.test/web-1"}


@pytest.mark.parametrize(
    "failing, saved, says",
    [
        ("deployment-show", {}, None),
        ("account-show", {}, None),
        ("registration", {}, None),
        ("web-create", {}, "No value for webClientId"),
        ("write-webClientId", {}, NOT_SAVED + "webClientId = 'web-1'"),
        ("write-webAppIdUri", {"webClientId": "web-1"}, NOT_SAVED + "webAppIdUri = 'api://app.example.test/web-1'"),
        ("reader-create", WEB_SAVED, "No value for sqlReaderClientId"),
        ("write-sqlReaderClientId", WEB_SAVED, NOT_SAVED + "sqlReaderClientId = 'reader-1'"),
    ],
)
def test_step_2_sets_up_no_app_it_has_not_saved(install, failing, saved, says):
    text = at_step(install, 2)
    (install.state / f"fail-{failing}").touch()
    r = run(install.home, install.state, SETUP, checked(STEP_2), FIXED, checked(STEP_2), prelude=WRITE_FAILS)
    (code, out), (again, _) = pasted(r)
    first, then = pastes(install.state)
    # It stops where it failed. Without says, that's before it prints anything: before it makes an app.
    assert code != 0
    assert out.splitlines()[-1:] == ([says] if says else [])
    assert setting_up(first) == []
    assert after_first(install) == fill(text, saved)
    # Fixed, and pasted again in the same shell: an app it already made is saved, not made again.
    assert again == 0, r.stdout + r.stderr
    assert setting_up(then) == SET_UP
    assert install.record.read_text(encoding="utf-8") == fill(text, WEB_IDS)
    assert made(install.state) == {"web": 1, "reader": 1}


def test_step_4_saves_the_workspace_before_it_sets_it_up(install):
    text = at_step(install, 4)
    r = run(install.home, install.state, SETUP, STEP_4)
    assert r.returncode == 0, r.stdout + r.stderr
    assert r.stdout.splitlines() == ["var workspace = 'ws-1'", "Server: sql.example.test  Database: db-1"]
    assert install.record.read_text(encoding="utf-8") == fill(text, {"workspace": "ws-1"})
    assert setting_up(calls(install.state)) == [MEMBER]
    assert made(install.state) == {"ws": 1}
    assert (install.home / "ValueLens.pbit").read_bytes() == b"report"


@pytest.mark.parametrize(
    "failing, says",
    [
        ("workspace-create", "No value for workspace"),
        ("write-workspace", NOT_SAVED + "workspace = 'ws-1'"),
        ("silently-write", NOT_SAVED + "workspace = 'ws-1'"),
    ],
)
def test_step_4_sets_up_no_workspace_it_has_not_saved(install, failing, says):
    text = at_step(install, 4)
    (install.state / f"fail-{failing}").touch()
    r = run(install.home, install.state, SETUP, checked(STEP_4), FIXED, checked(STEP_4), prelude=WRITE_FAILS)
    (code, out), (again, _) = pasted(r)
    first, then = pastes(install.state)
    assert code != 0 and out.splitlines()[-1] == says
    assert setting_up(first) == []
    assert after_first(install) == text
    assert again == 0, r.stdout + r.stderr
    assert setting_up(then) == [MEMBER]
    assert install.record.read_text(encoding="utf-8") == fill(text, {"workspace": "ws-1"})
    assert made(install.state) == {"ws": 1}


def test_steps_save_all_they_make_so_remove_can_delete_it(install):
    at_step(install, 1)
    for step in (STEP_1, STEP_2, STEP_4):
        r = run(install.home, install.state, SETUP, step)
        assert r.returncode == 0, r.stdout + r.stderr
    assert made(install.state) == {"web": 1, "reader": 1, "ws": 1}
    assert left(install) == ALL
    r = remove(install)
    assert "Not removed yet: resource-group." in r.stdout
    (install.state / "rg").unlink()
    r = remove(install)
    assert r.returncode == 0, r.stdout + r.stderr
    assert r.stdout.splitlines()[-1] == "Removed"
    assert left(install) == set()
    assert not install.record.exists()


def dataset(key: str, name: str) -> str:
    return f"put {key} $(az rest -u $API/groups/$WS/datasets --resource $PBI --query \"value[?name=='{name}'].id\" -o tsv)"


PUTS = [  # The page's other puts, as it has them: what's run, with yours filled in, and what it saves.
    ("put sqlLocation <region>", "put sqlLocation ukwest", "param sqlLocation = 'ukwest'"),
    (dataset("model", "Analytics Hub Model"), None, "var model = 'model-1'"),
    ("put sampleData true", None, "param sampleData = true"),
    ("put askMode create", None, "param askMode = 'create'"),
    ("put auditHistoryDays 90", None, "param auditHistoryDays = 90"),
    ("put runSchedule '0 6 * * *'", None, "param runSchedule = '0 6 * * *'"),
    ("put sqlUseFreeLimit true", None, "param sqlUseFreeLimit = true"),
    ("put modules core,orgData,consumption", None, "param modules = 'core,orgData,consumption'"),
    ("put azureAiSubscriptionId <id>", "put azureAiSubscriptionId sub-9", "param azureAiSubscriptionId = 'sub-9'"),
    (dataset("consumptionModel", "Analytics Hub Consumption Model"), None, "var consumptionModel = 'cmodel-1'"),
]


@pytest.mark.parametrize("page, line, saves", PUTS, ids=[p[0].split()[1] for p in PUTS])
def test_each_put_on_the_page_saves_or_says_it_has_not(install, page, line, saves):
    assert page in DOC
    line = (line or page) + "\n"
    (install.state / "fail-write").touch()
    r = run(install.home, install.state, SETUP, checked(line), FIXED, checked(line), prelude=WRITE_FAILS)
    (code, out), (again, out_again) = pasted(r)
    assert code != 0 and out == NOT_SAVED + saves.split(" ", 1)[1] + "\n"
    assert after_first(install) == install.text
    assert again == 0 and out_again == saves + "\n"
    name, value = saves.split(" ", 1)[1].split(" = ")
    assert install.record.read_text(encoding="utf-8") == fill(install.text, {name: value.strip("'")})


def test_every_put_on_the_page_is_tested():
    names = set(re.findall(r"^(?:// )?(?:param|var) (\w+) = ", TEMPLATE, re.M))
    on_the_page = set(re.findall(r"\bput (\w+)", DOC[DOC.index("## Azure"):])) & names
    in_steps = set(re.findall(r"\bput (\w+)", STEP_1 + STEP_2 + STEP_4))
    assert in_steps == {*WHERE, *WEB_IDS, "workspace"}
    assert on_the_page == in_steps | {page.split()[1] for page, _, _ in PUTS}


@pytest.mark.parametrize(
    "line, says",
    [("put noSuchSetting x", NOT_SAVED + "noSuchSetting = 'x'"), ("put workspace", "No value for workspace")],
)
def test_put_says_when_it_has_nothing_to_save(install, line, says):
    r = run(install.home, install.state, SETUP, line + "\n")
    assert r.returncode != 0
    assert r.stdout == says + "\n"
    assert install.record.read_text(encoding="utf-8") == install.text


@pytest.mark.parametrize("value", ["123", "true"])
def test_put_saves_ids_and_names_as_text_whatever_they_look_like(install, value):
    # Only the settings the template has as true, false or a number are saved bare. Anything else
    # is saved as text, even if it looks like one, so get reads it back.
    names = set(re.findall(r"^(?:// )?(?:param|var) (\w+) = ", TEMPLATE, re.M))
    typed = set(re.findall(r"^(?:// )?param (\w+) = (?:true|false|[0-9]+)\b", TEMPLATE, re.M))
    text = sorted((set(re.findall(r"\bput (\w+)", DOC[DOC.index("## Azure"):])) & names) - typed)
    assert {*WHERE, *WEB_IDS, "workspace", "model", "consumptionModel"} <= set(text)
    lines = "".join(f'put {n} {value} >/dev/null && [ "$(get {n})" = {value} ] || echo {n}\n' for n in text)
    r = run(install.home, install.state, SETUP, lines)
    assert r.stdout == "", r.stdout + r.stderr
    assert install.record.read_text(encoding="utf-8") == fill(install.text, dict.fromkeys(text, value))


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
# Where the test says: fail-checkout, git checkout fails; fail-copy-empty and fail-copy-part, cp
# makes its copy, then fails with it empty or part-written, as when the disk is full;
# fail-silently-copy-part, cp part-writes it but says it worked; fail-move, mv fails.
PART_FAILS = r"""
git() {
  [ "$1" != checkout ] || ! fails checkout || { echo "error: unable to unlink old file: Permission denied" >&2; return 1; }
  command git "$@"
}
cp() {
  if fails copy-empty; then : > "${@: -1}"
  elif fails copy-part; then head -c 20 "$1" > "${@: -1}"
  elif fails silently-copy-part; then head -c 20 "$1" > "${@: -1}"; return 0
  else command cp "$@"; return; fi
  echo "cp: error writing '${@: -1}': Disk quota exceeded" >&2; return 1
}
mv() { ! fails move || { echo "mv: cannot move '$1': Permission denied" >&2; return 1; }; command mv "$@"; }
"""


def released(version: str) -> str:
    """A release's main.bicepparam, in the stand-in for GitHub."""
    return f"// {version}\n{COMPLETE}\n"


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
        (infra / "main.bicepparam").write_text(released(version) if azure_by_hand else f"// {version}\n", newline="\n")
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
        home=home, state=state, clone=clone, record=clone / "azure" / "infra" / "my.bicepparam",
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
    assert github.record.read_text(encoding="utf-8") == released("9.9.9")
    assert [c.split()[-1] for c in calls(github.state) if "/manifests/" in c] == [
        "https://ghcr.io/v2/microsoft/valuelens-jobs/manifests/9.9.9",
        "https://ghcr.io/v2/microsoft/valuelens-web/manifests/9.9.9",
    ]


def test_get_the_files_again_keeps_the_record_and_waits_for_the_images(github):
    github.latest(LATEST + "9.9.9")
    github.publish("9.9.9")
    assert github.get().returncode == 0
    filled = f"// 9.9.9\nparam webClientId = 'web-1'\n{COMPLETE}\n"
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
    assert github.record.read_text(encoding="utf-8") == released("9.9.9")


# The record is made whole or not at all, and Get the files uses it only if it's whole: it ends
# with the template's last line.

UNFINISHED = "Not using azure/infra/my.bicepparam: it's incomplete. Move it aside, paste this again, then put back any IDs it has: mv azure/infra/my.bicepparam ~/my.bicepparam.old"


@pytest.mark.parametrize("failing", ["checkout", "copy-empty", "copy-part", "move"])
def test_get_the_files_makes_no_record_if_it_fails_then_a_whole_one(github, failing):
    github.latest(LATEST + "9.9.9")
    github.publish("9.9.9")
    (github.state / f"fail-{failing}").touch()
    r = run(github.home, github.state, checked(GET_FILES), FIXED, checked(GET_FILES), prelude=PART_FAILS)
    (code, out), (again, out_again) = pasted(r)
    # It stops with the command's own error: there's no record to move aside.
    assert code != 0 and out == ""
    assert after_first(github) is None
    # Fixed, and pasted again in the same shell.
    assert again == 0, r.stdout + r.stderr
    assert out_again.splitlines()[-1] == "Using installer-v9.9.9"
    assert github.record.read_text(encoding="utf-8") == released("9.9.9")
    assert sorted(p.name for p in github.record.parent.glob("my.bicepparam*")) == ["my.bicepparam"]


@pytest.mark.parametrize(
    "unfinished", ["", "// 9.9.9\nparam webClientId = 'web-1'\n// Keep th", None],
    ids=["empty", "part-written", "copied-part-written"],
)
def test_get_the_files_will_not_use_an_unfinished_record(github, unfinished):
    github.latest(LATEST + "9.9.9")
    github.publish("9.9.9")
    if unfinished is None:  # Made by a copy that said it worked.
        (github.state / "fail-silently-copy-part").touch()
        r = github.get(prelude=PART_FAILS)
        (github.state / "fail-silently-copy-part").unlink()
        unfinished = github.record.read_text(encoding="utf-8")
        assert unfinished == released("9.9.9")[:20]
    else:
        assert github.get().returncode == 0
        github.record.write_text(unfinished, encoding="utf-8", newline="\n")
        r = github.get()
    assert r.returncode != 0 and "Using" not in r.stdout
    assert r.stdout.splitlines()[-1] == UNFINISHED
    assert github.record.read_text(encoding="utf-8") == unfinished
    # As it says, in the folder it leaves you in: move it aside, and paste this again.
    r = run(github.home, github.state, UNFINISHED.rsplit(": ", 1)[1] + "\n", GET_FILES, cwd=github.clone)
    assert r.returncode == 0, r.stdout + r.stderr
    assert r.stdout.splitlines()[-1] == "Using installer-v9.9.9"
    assert github.record.read_text(encoding="utf-8") == released("9.9.9")
    assert (github.home / "my.bicepparam.old").read_text(encoding="utf-8") == unfinished


@pytest.mark.parametrize("newline", ["\n", "\r\n"], ids=["lf", "crlf"])
def test_get_the_files_keeps_a_whole_record_and_copies_nothing_over_it(github, newline):
    github.latest(LATEST + "9.9.9")
    github.publish("9.9.9")
    assert github.get().returncode == 0
    filled = f"// 9.9.9\nparam webClientId = 'web-1'\n{COMPLETE}\n".replace("\n", newline).encode()
    github.record.write_bytes(filled)
    for failing in ("copy-empty", "move"):
        (github.state / f"fail-{failing}").touch()
    r = github.get(prelude=PART_FAILS)
    assert r.returncode == 0, r.stdout + r.stderr
    assert r.stdout.splitlines()[-1] == "Using installer-v9.9.9"
    assert github.record.read_bytes() == filled


def test_the_record_ends_with_the_line_that_shows_it_is_whole():
    assert TEMPLATE.endswith(f"\n{COMPLETE}\n") and TEMPLATE.count(COMPLETE) == 1
    assert f"grep -qF '{COMPLETE}' $R" in GET_FILES
    # put and Remove never rewrite it.
    assert not re.match(r"(// )?(param|var) ", COMPLETE)
