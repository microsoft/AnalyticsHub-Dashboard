"""The Copilot Managed App stays parked in ideas/.

Nothing in ideas/ is built, run, shipped or supported, so none of it may reach the app's build, CI,
the installer, the Azure images or the setup docs again. CodeQL must still scan all of it.
"""
from __future__ import annotations

import json
import posixpath
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
    # CodeQL must read every file in ideas/. No source-root, paths, paths-ignore, env, checkout input or
    # extra step may narrow it, and some init step must analyse JavaScript/TypeScript.
    workflows = {rel(p): p.read_text(encoding="utf-8") for p in (ROOT / ".github" / "workflows").glob("*.y*ml")}
    ideas = [rel(p) for p in files_under(IDEAS)]
    assert ideas
    problems = codeql_scope_problems(workflows, ideas, read_repo_file)
    assert not problems, "\n".join(problems)


def test_installer_has_no_managed_route():
    hits = matching_lines(files_under(ROOT / "installer", INSTALLER_SKIP), MANAGED_INSTALLER)
    assert not hits, "\n".join(hits)


def test_azure_images_do_not_copy_ideas():
    # azure-images.yml builds both images with the repository root as the build context, and the root has
    # no .dockerignore, so no COPY, ADD or bind mount may take ideas/ or the whole context.
    dockerfiles = sorted(p for p in (ROOT / "azure").rglob("Dockerfile*") if p.is_file())
    assert dockerfiles
    problems = [f"{rel(p)}: {problem}"
                for p in dockerfiles for problem in dockerfile_problems(p.read_bytes().decode("utf-8"))]
    assert not problems, "\n".join(problems)


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


# Helpers for the CodeQL and Docker guards. Each takes text and returns a list of problems, so the
# regressions at the end can run them on synthetic text. They fail closed: whatever they can't read is
# a problem, never a pass. They use the stdlib only, as CI installs no YAML library.


def read_repo_file(path: str) -> str | None:
    target = ROOT / path
    return target.read_text(encoding="utf-8") if target.is_file() else None


class YamlSubsetError(ValueError):
    pass


class LiteralBlock(str):
    pass


class FoldedBlock(str):
    pass


# The YAML that workflows and CodeQL configs use: block mappings and lists, plain and quoted scalars,
# [a, b] lists and | or > blocks. Flow mappings, anchors, aliases, tags, merge keys, multi-line
# scalars and tabs raise YamlSubsetError.
YAML_RESERVED_START = re.compile(r"""[\[\]{},#&*!|>'"%@`]|[-?:](?:\s|$)""")
YAML_PLAIN_KEY = re.compile(r"(.*?):(?: +|$)")
YAML_SINGLE = re.compile(r"'(?:[^']|'')*'")
YAML_DOUBLE = re.compile(r'"(?:[^"\\]|\\.)*"')
YAML_DOC_MARKER = re.compile(r"(?:---|\.\.\.)(?:\s|$)")
YAML_BLOCK_HEADER = re.compile(r"[|>][+-]?")
YAML_QUOTE_OPENERS = ("", ":", "-", "[", ",", "?", "{")


def _is_seq_item(content: str) -> bool:
    return content == "-" or content.startswith("- ")


def _strip_comment(line: str, n: int) -> str:
    quote, i = None, 0
    while i < len(line):
        c = line[i]
        if quote == "'":
            if c == "'" and line[i + 1:i + 2] == "'":
                i += 1
            elif c == "'":
                quote = None
        elif quote == '"':
            if c == "\\":
                i += 1
            elif c == '"':
                quote = None
        elif c == "#" and (i == 0 or line[i - 1] in " \t"):
            return line[:i].rstrip()
        elif c in "'\"" and (i == 0 or line[i - 1] in " \t[,{") and line[:i].strip()[-1:] in YAML_QUOTE_OPENERS:
            quote = c
        i += 1
    if quote:
        raise YamlSubsetError(f"line {n} has a quote that doesn't close on the same line")
    return line.rstrip()


def _unquote(text: str, n: int) -> str:
    if text[0] == "'":
        return text[1:-1].replace("''", "'")
    try:
        return json.loads(text)
    except ValueError as err:
        raise YamlSubsetError(f"line {n} has an escape the guard can't read: {text}") from err


def _plain(text: str, n: int, flow: bool = False) -> str:
    if (not text or YAML_RESERVED_START.match(text) or ": " in text or text.endswith(":")
            or (flow and any(c in text for c in "[]{}"))):
        raise YamlSubsetError(f"line {n} has a value the guard can't read: {text!r}")
    return text


def _split_key(content: str, n: int) -> tuple[str, str] | None:
    if content[0] in "'\"":
        match = (YAML_SINGLE if content[0] == "'" else YAML_DOUBLE).match(content)
        if not match:
            raise YamlSubsetError(f"line {n} has a quote that doesn't close")
        after = content[match.end():]
        if after != ":" and not after.startswith(": "):
            return None
        return _unquote(match.group(0), n), after[1:].lstrip(" ")
    if content.startswith(("[", "{")):
        return None
    match = YAML_PLAIN_KEY.match(content)
    if not match:
        return None
    key = match.group(1).rstrip()
    if not key or key == "<<" or YAML_RESERVED_START.match(key):
        raise YamlSubsetError(f"line {n} has a key the guard can't read: {key!r}")
    return key, content[match.end():]


def _flow_list(text: str, n: int) -> list[str]:
    if not text.endswith("]"):
        raise YamlSubsetError(f"line {n} has a [ list the guard can't read: {text!r}")
    inner, pos, items = text[1:-1], 0, []
    while True:
        while inner[pos:pos + 1] == " ":
            pos += 1
        if pos == len(inner):
            return items
        if inner[pos] in "'\"":
            match = (YAML_SINGLE if inner[pos] == "'" else YAML_DOUBLE).match(inner, pos)
            if not match:
                raise YamlSubsetError(f"line {n} has a [ list the guard can't read: {text!r}")
            items.append(_unquote(match.group(0), n))
            pos = match.end()
        else:
            end = inner.find(",", pos)
            end = len(inner) if end < 0 else end
            items.append(_plain(inner[pos:end].rstrip(" "), n, flow=True))
            pos = end
        while inner[pos:pos + 1] == " ":
            pos += 1
        if pos == len(inner):
            return items
        if inner[pos] != ",":
            raise YamlSubsetError(f"line {n} has a [ list the guard can't read: {text!r}")
        pos += 1


class _YamlReader:
    def __init__(self, text: str):
        self.lines = text.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n").split("\n")
        self.i, self.pending, self.started = 0, None, False

    def peek(self) -> tuple[int, str, int] | None:
        if self.pending is not None:
            return self.pending
        while self.i < len(self.lines):
            n = self.i + 1
            body = _strip_comment(self.lines[self.i], n)
            if not body.strip():
                self.i += 1
                continue
            if "\t" in body:
                raise YamlSubsetError(f"line {n} has a tab")
            content = body.lstrip(" ")
            indent = len(body) - len(content)
            if indent == 0 and YAML_DOC_MARKER.match(content):
                if content == "---" and not self.started:
                    self.started = True
                    self.i += 1
                    continue
                raise YamlSubsetError(f"line {n} starts another document")
            self.started = True
            return indent, content, n
        return None

    def advance(self) -> None:
        if self.pending is not None:
            self.pending = None
        else:
            self.i += 1

    def node(self, indent: int):
        return self.sequence(indent) if _is_seq_item(self.peek()[1]) else self.mapping(indent)

    def mapping(self, indent: int) -> dict:
        result = {}
        while (line := self.peek()) is not None and line[0] >= indent:
            at, content, n = line
            if at > indent or _is_seq_item(content):
                raise YamlSubsetError(f"line {n} doesn't fit the mapping it's in")
            split = _split_key(content, n)
            if split is None:
                raise YamlSubsetError(f"line {n} isn't a key: value line the guard can read")
            key, rest = split
            if key in result:
                raise YamlSubsetError(f"line {n} repeats the key {key!r}")
            self.advance()
            result[key] = self.value(rest, at, n)
        return result

    def value(self, text: str, indent: int, n: int):
        if text:
            return self.scalar_or_flow(text, indent, n)
        line = self.peek()
        if line is not None and (line[0] > indent or (line[0] == indent and _is_seq_item(line[1]))):
            return self.node(line[0])
        return None

    def sequence(self, indent: int) -> list:
        result = []
        while (line := self.peek()) is not None and line[0] >= indent:
            at, content, n = line
            if at == indent and not _is_seq_item(content):
                break
            if at > indent:
                raise YamlSubsetError(f"line {n} doesn't fit the list it's in")
            self.advance()
            rest = content[1:].lstrip(" ")
            if not rest:
                after = self.peek()
                result.append(self.node(after[0]) if after is not None and after[0] > at else None)
            elif _is_seq_item(rest) or _split_key(rest, n) is not None:
                self.pending = (at + len(content) - len(rest), rest, n)
                result.append(self.node(self.pending[0]))
            else:
                result.append(self.scalar_or_flow(rest, at, n))
        return result

    def scalar_or_flow(self, text: str, indent: int, n: int):
        if text[0] in "|>":
            if not YAML_BLOCK_HEADER.fullmatch(text):
                raise YamlSubsetError(f"line {n} has a block header the guard can't read: {text!r}")
            return self.block(indent, LiteralBlock if text[0] == "|" else FoldedBlock)
        if text[0] == "[":
            return _flow_list(text, n)
        if text[0] in "'\"":
            if not (YAML_SINGLE if text[0] == "'" else YAML_DOUBLE).fullmatch(text):
                raise YamlSubsetError(f"line {n} has a quoted value the guard can't read: {text!r}")
            return _unquote(text, n)
        return _plain(text, n)

    def block(self, parent: int, kind: type) -> str:
        lines, width = [], None
        while self.i < len(self.lines):
            raw = self.lines[self.i]
            if raw.strip():
                at = len(raw) - len(raw.lstrip(" "))
                if at <= parent:
                    break
                if width is None:
                    width = at
                elif at < width:
                    raise YamlSubsetError(f"line {self.i + 1} is indented less than the block it's in")
                lines.append(raw[width:])
            else:
                lines.append("")
            self.i += 1
        while lines and not lines[-1]:
            lines.pop()
        return kind("\n".join(lines) + "\n" if lines else "")


def parse_yaml_subset(text: str):
    reader = _YamlReader(text)
    first = reader.peek()
    if first is None:
        return None
    result = reader.node(first[0])
    left = reader.peek()
    if left is not None:
        raise YamlSubsetError(f"line {left[2]} is outside the document's structure")
    return result


# CodeQL reads the whole checkout unless something narrows it. So the guard reads everything that could:
# init's inputs, the config, trigger paths, LGTM_ and CODEQL_ env, and any step or input it doesn't know.
CHECKOUT = "actions/checkout"
CODEQL_INIT = "github/codeql-action/init"
CODEQL_ANALYZE = "github/codeql-action/analyze"
JS_LANGUAGES = {"javascript-typescript", "javascript", "typescript"}
INIT_CHECKED = {"languages", "source-root", "config", "config-file"}
# These change how CodeQL runs, not which files it reads.
INIT_HARMLESS = {"build-mode", "queries", "packs", "tools", "debug", "ram", "threads", "dependency-caching"}
ANALYZE_INPUTS = {"category", "ram", "threads", "output", "wait-for-processing", "add-snippets"}
CHECKOUT_INPUTS = {"fetch-depth", "fetch-tags", "persist-credentials", "clean", "lfs", "submodules",
                   "show-progress", "token", "set-safe-directory"}
STEP_KEYS = {"name", "id", "uses", "with", "env", "timeout-minutes"}
CONFIG_KEYS = {"name", "disable-default-queries", "queries", "packs", "query-filters", "paths", "paths-ignore"}
WORKSPACE_ROOT = re.compile(r"(?:\.|\$\{\{\s*github\.workspace\s*\}\})/?")
MATRIX_REF = re.compile(r"\$\{\{\s*matrix\.([A-Za-z_][\w-]*)\s*\}\}")


def _action(step: dict) -> str:
    uses = step.get("uses")
    return uses.split("@")[0].strip().lower() if isinstance(uses, str) else ""


def codeql_scope_problems(workflows: dict[str, str], ideas: list[str], read_local) -> list[str]:
    """Everything in these workflows that could stop CodeQL reading a file in ideas/."""
    problems, found, js = [], False, False
    for name, text in sorted(workflows.items()):
        if "codeql-action" not in text.lower():
            continue
        try:
            doc = parse_yaml_subset(text)
        except YamlSubsetError as err:
            problems.append(f"{name}: can't read it safely: {err}")
            continue
        jobs = doc.get("jobs") if isinstance(doc, dict) else None
        if not isinstance(jobs, dict):
            problems.append(f"{name}: can't read it safely: it has no jobs mapping")
            continue
        scans = False
        for job_name, job in jobs.items():
            where = f"{name}: job {job_name}"
            if not isinstance(job, dict):
                problems.append(f"{where} isn't a mapping the guard can read")
                continue
            steps = job.get("steps")
            if steps is None:
                continue
            if not isinstance(steps, list) or not all(isinstance(step, dict) for step in steps):
                problems.append(f"{where} has steps the guard can't read")
                continue
            if any(_action(step) == CODEQL_INIT for step in steps):
                scans = True
                job_js, job_problems = _codeql_job_problems(where, job, steps, ideas, read_local)
                js, problems = js or job_js, problems + job_problems
        if scans:
            found = True
            problems += _env_problems(f"{name}: workflow", doc.get("env"))
            problems += _trigger_problems(name, doc.get("on"), ideas)
    if not found and not problems:
        problems.append("no workflow has a github/codeql-action/init step, so nothing scans ideas/")
    elif found and not js and not problems:
        problems.append("no CodeQL init step analyses JavaScript/TypeScript, which is what ideas/ holds")
    return problems


def _codeql_job_problems(where: str, job: dict, steps: list, ideas: list[str], read_local) -> tuple[bool, list[str]]:
    js, checked_out = False, False
    problems = [f"{where} has an if:, which could skip the scan"] if "if" in job else []
    problems += _env_problems(where, job.get("env"))
    for n, step in enumerate(steps, 1):
        at, action = f"{where} step {n}", _action(step)
        if action not in (CHECKOUT, CODEQL_INIT, CODEQL_ANALYZE):
            problems.append(f"{at}: only checkout, CodeQL init and analyze steps are understood here; "
                            "check this one leaves ideas/ in place, then allow it here")
            continue
        problems += [f"{at} has {key!r}, which could skip it or change what it does; review it, then allow it here"
                     for key in step if key not in STEP_KEYS]
        problems += _env_problems(at, step.get("env"))
        inputs = {} if step.get("with") is None else step["with"]
        if not isinstance(inputs, dict):
            problems.append(f"{at} has a with: the guard can't read")
        elif action == CHECKOUT:
            checked_out = True
            problems += [f"{at}: checkout input {key!r} could leave ideas/ out; review it, then allow it here"
                         for key in inputs if key not in CHECKOUT_INPUTS]
        elif action == CODEQL_INIT:
            if not checked_out:
                problems.append(f"{at} runs before any checkout, so there'd be nothing to scan")
            step_js, step_problems = _init_problems(at, job, inputs, ideas, read_local)
            js, problems = js or step_js, problems + step_problems
        else:
            problems += [f"{at}: analyze input {key!r} could drop the scan's results; review it, then allow it here"
                         for key in inputs if key not in ANALYZE_INPUTS]
    return js, problems


def _env_problems(where: str, env) -> list[str]:
    if env is None:
        return []
    if not isinstance(env, dict):
        return [f"{where} env isn't a mapping the guard can read"]
    return [f"{where} env {key} can change what CodeQL extracts" for key in env
            if key.upper().startswith(("LGTM_", "CODEQL_"))]


def _init_problems(at: str, job: dict, inputs: dict, ideas: list[str], read_local) -> tuple[bool, list[str]]:
    problems = [f"{at}: init input {key!r} isn't known to keep ideas/ in scope; review it, then allow it here"
                for key in inputs if key not in INIT_CHECKED | INIT_HARMLESS]
    root = inputs.get("source-root")
    if root is not None and not (isinstance(root, str) and WORKSPACE_ROOT.fullmatch(root.strip())):
        problems.append(f"{at} source-root {root!r} narrows the scan; only the repository root keeps ideas/ in it")
    languages, js = inputs.get("languages"), True  # With no languages, CodeQL finds them itself.
    if languages is not None:
        values, problem = _language_values(job, languages)
        if problem:
            problems.append(f"{at} languages {problem}")
        js = any(part.strip().lower() in JS_LANGUAGES for value in values for part in value.split(","))
    config = inputs.get("config")
    if isinstance(config, LiteralBlock):
        problems += _config_problems(f"{at} config", config, ideas)
    elif config is not None:
        problems.append(f"{at} config must be a literal | block so the guard can read it")
    if inputs.get("config-file") is not None:
        problems += _config_file_problems(at, inputs["config-file"], ideas, read_local)
    return js, problems


def _language_values(job: dict, languages) -> tuple[list[str], str | None]:
    if not isinstance(languages, str):
        return [], "isn't a value the guard can read"
    match = MATRIX_REF.fullmatch(languages.strip())
    if match:
        return _matrix_values(job, match.group(1))
    if "${{" in languages:
        return [], "uses an expression the guard can't resolve"
    return [languages], None


def _matrix_values(job: dict, key: str) -> tuple[list[str], str | None]:
    strategy = job.get("strategy")
    matrix = strategy.get("matrix") if isinstance(strategy, dict) else None
    if not isinstance(matrix, dict):
        return [], "comes from a matrix the guard can't read"
    if "exclude" in matrix:
        return [], "comes from a matrix with an exclude, which could drop JavaScript/TypeScript"
    values, include = matrix.get(key, []), matrix.get("include", [])
    if not isinstance(values, list) or not isinstance(include, list) or not all(isinstance(r, dict) for r in include):
        return [], "comes from a matrix the guard can't read"
    values = values + [row[key] for row in include if key in row]
    if not values or not all(isinstance(value, str) and value and "${{" not in value for value in values):
        return [], "comes from a matrix the guard can't read"
    return values, None


def _config_file_problems(at: str, value, ideas: list[str], read_local) -> list[str]:
    if not isinstance(value, str) or "${{" in value:
        return [f"{at} config-file isn't a path the guard can resolve"]
    if "@" in value and not value.startswith("./"):
        return [f"{at} config-file {value!r} is a remote file the guard can't read"]
    path = posixpath.normpath(value)
    if "\\" in path or path.startswith("/") or path in (".", "..") or path.startswith("../"):
        return [f"{at} config-file {value!r} isn't a file in this repository the guard can read"]
    text = read_local(path)
    if text is None:
        return [f"{at} config-file {value!r} doesn't exist, so the guard can't check it"]
    return _config_problems(f"{at} config-file {path}", text, ideas)


def _config_problems(where: str, text: str, ideas: list[str]) -> list[str]:
    try:
        config = parse_yaml_subset(text)
    except YamlSubsetError as err:
        return [f"{where}: can't read it safely: {err}"]
    if config is None:
        return []
    if not isinstance(config, dict):
        return [f"{where} isn't a mapping the guard can read"]
    problems = [f"{where} has {key!r}, which the guard doesn't know; review it, then allow it here"
                for key in config if key not in CONFIG_KEYS]
    for key in ("paths", "paths-ignore"):
        if key in config:
            problems += _pattern_problems(f"{where} {key}", config[key], ideas, include=key == "paths", exact=False)
    return problems


def _trigger_problems(name: str, on, ideas: list[str]) -> list[str]:
    # A trigger's paths filter decides whether a change to ideas/ starts a scan at all.
    problems = []
    for event, settings in on.items() if isinstance(on, dict) else []:
        for key in ("paths", "paths-ignore"):
            if isinstance(settings, dict) and key in settings:
                problems += _pattern_problems(f"{name}: on.{event}.{key}", settings[key], ideas,
                                              include=key == "paths", exact=True)
    return problems


def _pattern_problems(where: str, patterns, ideas: list[str], include: bool, exact: bool) -> list[str]:
    # CodeQL's paths cover a folder's files too (exact=False). A trigger's paths match whole file paths.
    if not isinstance(patterns, list) or not all(isinstance(p, str) for p in patterns):
        return [f"{where} isn't a list of paths the guard can read"]
    parsed = [(p, _path_pattern(p, normalise=not (include and exact))) for p in patterns]
    problems = [f"{where}: the pattern {p!r} isn't understood here, so the guard can't tell what it covers"
                for p, parts in parsed if parts is None]
    if problems:
        return problems
    if include:
        missed = [f for f in ideas if not any(_covers(parts, f, parents=not exact, fold=False) for _, parts in parsed)]
        return [f"{where} leaves out {len(missed)} file(s) under ideas/, such as {missed[0]}"] if missed else []
    dropped = [f for f in ideas if any(_covers(parts, f, parents=True, fold=True) for _, parts in parsed)]
    return [f"{where} drops {len(dropped)} file(s) under ideas/, such as {dropped[0]}"] if dropped else []


def _path_pattern(pattern: str, normalise: bool) -> list[str] | None:
    if pattern != pattern.strip() or any(c in pattern for c in "\\?+[]!{}"):
        return None
    if normalise:
        while pattern.startswith(("./", "/")):
            pattern = pattern[2:] if pattern.startswith("./") else pattern[1:]
        pattern = pattern.rstrip("/")
    parts = pattern.split("/")
    if not pattern or any(part in ("", ".", "..") or ("**" in part and part != "**") for part in parts):
        return None
    return parts


def _glob_match(pattern: list[str], parts: list[str], fold: bool) -> bool:
    if not pattern:
        return not parts
    if pattern[0] == "**":
        return any(_glob_match(pattern[1:], parts[i:], fold) for i in range(len(parts) + 1))
    if not parts:
        return False
    regex = ".*".join(map(re.escape, pattern[0].split("*")))
    return (re.fullmatch(regex, parts[0], re.S | (re.I if fold else 0)) is not None
            and _glob_match(pattern[1:], parts[1:], fold))


def _covers(pattern: list[str], path: str, parents: bool, fold: bool) -> bool:
    parts = path.split("/")
    ends = range(1, len(parts) + 1) if parents else [len(parts)]
    return any(_glob_match(pattern, parts[:end], fold) for end in ends)


# The Docker guard reads a Dockerfile the way BuildKit does: comment and blank lines dropped, lines that
# end in \ joined, then every COPY, ADD and bind --mount source checked against the build context.
DOCKER_DIRECTIVE = re.compile(r"#\s*([A-Za-z][A-Za-z0-9]*)\s*=\s*(.+?)\s*")
DOCKER_FRONTEND = re.compile(r"(?:docker\.io/)?docker/dockerfile(?::[\w.-]+)?(?:@sha256:[0-9a-f]{64})?")
DOCKER_CONTINUATION = re.compile(r"\\[ \t]*$")


def dockerfile_problems(text: str) -> list[str]:
    """Everything in this Dockerfile that could put ideas/ in the image, or that the guard can't read."""
    text = text.lstrip("\ufeff")
    lines = [line.rstrip("\r\n") for line in text.split("\n")]
    if lines[0].startswith(("#!", "//")) or text.lstrip().startswith("{"):
        return ["line 1: starts with #!, // or {, which can pick a frontend the guard doesn't know"]
    problems = []
    for n, line in enumerate(lines, 1):
        match = DOCKER_DIRECTIVE.fullmatch(line.strip())
        if not match or match.group(1).lower() not in ("syntax", "escape", "check"):
            break
        name, value = match.group(1).lower(), match.group(2)
        if name == "escape" and value != "\\":
            problems.append(f"line {n}: escape={value} changes how lines continue, which the guard doesn't read")
        elif name == "syntax" and not DOCKER_FRONTEND.fullmatch(value):
            problems.append(f"line {n}: syntax={value} is a frontend the guard doesn't know")
    return problems + [f"line {n}: {problem}" for n, instruction in _docker_instructions(lines)
                       for problem in _docker_instruction_problems(instruction)]


def _docker_instructions(lines: list[str]):
    start, current = 0, None
    for n, line in enumerate(lines, 1):
        if current is None:
            line = line.lstrip()
            if not line or line.startswith("#"):
                continue
            start, current = n, ""
        elif not line.strip() or line.lstrip().startswith("#"):
            continue
        match = DOCKER_CONTINUATION.search(line)
        if match:
            current += line[:match.start()]
        else:
            yield start, current + line
            current = None
    if current is not None:
        yield start, current


def _docker_instruction_problems(instruction: str) -> list[str]:
    words = instruction.split(None, 1)
    if words and words[0].upper() == "ONBUILD":
        words = words[1].split(None, 1) if len(words) > 1 else []
    if not words or words[0].upper() not in ("COPY", "ADD", "RUN"):
        return []
    name, rest = words[0].upper(), words[1] if len(words) > 1 else ""
    if "<<" in rest:
        return [f"{name} uses a heredoc, which the guard doesn't read"]
    flags = []
    while rest.startswith("--"):
        flag, rest = re.match(r"(\S+)\s*(.*)", rest, re.S).groups()
        if flag == "--":
            break
        if any(c in flag for c in "\"'\\"):
            return [f"{name} has a quoted or escaped flag the guard doesn't read"]
        flags.append(flag)
    if name == "RUN":
        return [problem for flag in flags if flag.lower().startswith("--mount=")
                for problem in _mount_problems(flag[len("--mount="):])]
    for flag in flags:
        if name == "COPY" and flag.startswith("--from="):
            stage = flag[len("--from="):]
            return [] if stage and "$" not in stage else [f"{name} has a --from the guard can't resolve"]
    if rest.startswith("["):
        try:
            args = json.loads(rest)
        except ValueError:
            return [f"{name} has a [ form that isn't valid JSON, so the guard can't tell what it copies"]
        if not isinstance(args, list) or not all(isinstance(arg, str) for arg in args):
            return [f"{name} has a JSON form the guard can't read"]
    else:
        args = rest.split()
    if len(args) < 2:
        return [f"{name} needs a source and a destination, and the guard can't find both"]
    return [f"{name} source {source!r} {problem}" for source in args[:-1]
            if (problem := _context_source_problem(source))]


def _mount_problems(spec: str) -> list[str]:
    if any(c in spec for c in "$\"'"):
        return ["RUN has a --mount with variables or quotes the guard doesn't read"]
    fields, sources = {}, []
    for field in spec.split(","):
        key, _, value = field.partition("=")
        if key.lower() in ("source", "src"):
            sources.append(value)
        else:
            fields[key.lower()] = value
    if fields.get("type", "bind").lower() != "bind" or fields.get("from"):
        return []
    return [f"RUN has a bind --mount that {problem}" for source in sources or ["."]
            if (problem := _context_source_problem(source))]


def _context_source_problem(source: str) -> str | None:
    if any(c in source for c in "$\"'\\"):
        return "uses variables, quotes or escapes the guard doesn't expand"
    # BuildKit keeps every source inside the context, so a leading / or .. stays at its root.
    path = posixpath.normpath("/" + source).lstrip("/")
    if not path:
        return "takes the whole build context (the repository root), ideas/ included"
    top = path.split("/")[0]
    if any(c in top for c in "*?["):
        return "has a top-level wildcard, which could match ideas/"
    if top.lower() == "ideas":
        return "takes ideas/ from the build context"
    return None


# Regressions for both guards. Each case changes the real file's text and names the problem it expects;
# None means it must pass.
CODEQL_WORKFLOW = ".github/workflows/codeql.yml"
CODEQL_CONFIG = ".github/codeql/codeql-config.yml"
LANGS = "languages: ${{ matrix.language }}"
DOCKERFILES = {"jobs": ROOT / "azure" / "jobs" / "Dockerfile", "web": ROOT / "azure" / "web" / "Dockerfile"}


def _line_of(rows: list[str], anchor: str) -> int:
    found = next((i for i, row in enumerate(rows) if anchor in row), None)
    assert found is not None, f"the regression's anchor {anchor!r} has gone from the real file"
    return found


def _after(text: str, anchor: str, *lines: str) -> str:
    rows = text.split("\n")
    at = _line_of(rows, anchor) + 1
    return "\n".join(rows[:at] + list(lines) + rows[at:])


def _drop(text: str, anchor: str) -> str:
    rows = text.split("\n")
    at = _line_of(rows, anchor)
    return "\n".join(rows[:at] + rows[at + 1:])


def _swap(text: str, old: str, new: str) -> str:
    assert old in text, f"the regression's anchor {old!r} has gone from the real file"
    return text.replace(old, new, 1)


def _init(text: str, *lines: str) -> str:
    # Replaces whatever follows languages: in init's with: by these lines, so each case tests only its own.
    rows = text.split("\n")
    at = next((i for i, row in enumerate(rows) if row.strip() == LANGS), None)
    assert at is not None, f"the regression's anchor {LANGS!r} has gone from the real file"
    indent = len(rows[at]) - len(rows[at].lstrip(" "))
    end = at + 1
    while end < len(rows) and (not rows[end].strip() or len(rows[end]) - len(rows[end].lstrip(" ")) >= indent):
        end += 1
    return "\n".join(rows[:at + 1] + [" " * indent + line for line in lines] + rows[end:])


def _dockerfile(base: str | None, lines: list[str], before: bool) -> str:
    text = DOCKERFILES[base].read_bytes().decode("utf-8") if base else ""
    if text and not text.endswith("\n"):
        text += "\n"
    added = "".join(line + "\n" for line in lines)
    return added + text if before else text + added


CODEQL_CASES = [
    # These must fail, for the reason given.
    pytest.param(lambda t: _init(t, "source-root: app"), {}, "source-root", id="source-root-app"),
    pytest.param(lambda t: _init(t, "config: |", "  paths: [app]"), {}, "paths leaves out", id="config-paths-app"),
    pytest.param(lambda t: _init(t, "config: |", "  paths-ignore: [ideas]"), {}, "paths-ignore",
                 id="config-paths-ignore-ideas"),
    pytest.param(lambda t: _init(t, "config: |", "  paths-ignore: ['ideas/**']"), {}, "paths-ignore",
                 id="config-paths-ignore-ideas-glob"),
    pytest.param(lambda t: _init(t, "config: |", "  paths-ignore: ['**/*.ts']"), {}, "paths-ignore",
                 id="config-paths-ignore-all-ts"),
    pytest.param(lambda t: _init(t, "config: |", "  paths-ignore: [IDEAS]"), {}, "paths-ignore",
                 id="config-paths-ignore-upper-case"),
    pytest.param(lambda t: _init(t, "config: |", "  paths-ignore: ['app/../ideas']"), {}, "isn't understood",
                 id="config-paths-ignore-dot-dot"),
    pytest.param(lambda t: _init(t, 'config: "paths-ignore: [ideas]"'), {}, "literal | block", id="config-quoted"),
    pytest.param(lambda t: _init(t, "config: >", "  paths-ignore: [ideas]"), {}, "literal | block", id="config-folded"),
    pytest.param(lambda t: _init(t, "config-file: owner/repo/codeql.yml@main"), {}, "remote", id="config-file-remote"),
    pytest.param(lambda t: _init(t, "config-file: ./missing.yml"), {}, "doesn't exist", id="config-file-missing"),
    pytest.param(lambda t: _init(t, f"config-file: ./{CODEQL_CONFIG}"),
                 {CODEQL_CONFIG: "paths-ignore:\n  - ideas/managed-app\n"}, "paths-ignore",
                 id="config-file-ignores-ideas"),
    pytest.param(lambda t: _init(t, "db-location: /tmp/codeql"), {}, "db-location", id="unknown-init-input"),
    pytest.param(lambda t: _swap(t, "[javascript-typescript, python, actions]", "[python, actions]"), {},
                 "JavaScript", id="matrix-without-js"),
    pytest.param(lambda t: _after(t, "language: [", "        exclude:", "          - language: javascript-typescript"),
                 {}, "exclude", id="matrix-exclude"),
    pytest.param(lambda t: _swap(t, LANGS, "languages: ${{ inputs.languages }}"), {}, "expression",
                 id="languages-expression"),
    pytest.param(lambda t: _after(t, "cancel-in-progress: true", "env:", "  LGTM_INDEX_EXCLUDE: ideas"), {},
                 "LGTM_INDEX_EXCLUDE", id="workflow-env"),
    pytest.param(lambda t: _after(t, "actions/checkout@", "        with:", "          sparse-checkout: app"), {},
                 "sparse-checkout", id="sparse-checkout"),
    pytest.param(lambda t: _after(t, "actions/checkout@", "      - run: rm -rf ideas"), {}, "only checkout",
                 id="extra-step"),
    pytest.param(lambda t: _drop(t, "actions/checkout@"), {}, "before any checkout", id="no-checkout"),
    pytest.param(lambda t: _after(t, "timeout-minutes: 30", "    if: false"), {}, "could skip", id="job-if"),
    pytest.param(lambda t: _after(t, "codeql-action/init@", "        if: false"), {}, "'if'", id="step-if"),
    pytest.param(lambda t: _after(t, "category:", "          skip-queries: true"), {}, "skip-queries",
                 id="analyze-skip-queries"),
    pytest.param(lambda t: _after(t, "  pull_request:", "    paths-ignore: ['ideas/**']"), {}, "paths-ignore",
                 id="trigger-paths-ignore"),
    pytest.param(lambda t: _after(t, "  push:", "    paths: ['app/**']"), {}, "on.push.paths leaves out",
                 id="trigger-paths"),
    pytest.param(lambda t: _swap(t, "with:\n          " + LANGS, "with: { languages: python }"), {},
                 "can't read it safely", id="flow-mapping"),
    pytest.param(lambda t: _swap(t, "  " + LANGS, "\t" + LANGS), {}, "can't read it safely", id="tab"),
    pytest.param(lambda t: _swap(t, "language: [", "language: &langs ["), {}, "can't read it safely", id="anchor"),
    # These must pass.
    pytest.param(lambda t: t, {}, None, id="real-file"),
    pytest.param(lambda t: _after(t, "Scheduled runs only start", "# Includes ideas/ in static analysis."), {}, None,
                 id="comment-at-top"),
    pytest.param(lambda t: _init(t, "# Includes ideas/ in static analysis."), {}, None, id="comment-in-with"),
    pytest.param(lambda t: _init(t, "config: |", "  paths: [app, ideas]"), {}, None, id="config-paths-app-and-ideas"),
    pytest.param(lambda t: _init(t, "config: |", "  paths:", "    - app", "    - ideas"), {}, None,
                 id="config-paths-block-list"),
    pytest.param(lambda t: _init(t, "config: |", "  paths: ['**']"), {}, None, id="config-paths-everything"),
    pytest.param(lambda t: _init(t, "source-root: ${{ github.workspace }}"), {}, None, id="source-root-workspace"),
    pytest.param(lambda t: _init(t, f"config-file: ./{CODEQL_CONFIG}"),
                 {CODEQL_CONFIG: "name: Extra\npaths-ignore:\n  - samples\n"}, None, id="config-file-local"),
    pytest.param(lambda t: _init(t, "build-mode: none", "queries: security-extended"), {}, None,
                 id="harmless-init-inputs"),
    pytest.param(lambda t: _swap(t, LANGS, "languages: javascript-typescript"), {}, None, id="languages-literal"),
    pytest.param(lambda t: _after(t, "  push:", "    paths: ['**']"), {}, None, id="trigger-paths-everything"),
    pytest.param(lambda t: _after(t, "  pull_request:", "    paths-ignore: ['docs/**']"), {}, None,
                 id="trigger-paths-ignore-docs"),
]

DOCKER_CASES = [
    # These must fail, for the reason given. The second item says whether the lines go before the base file.
    pytest.param("web", False, ["COPY . /app/source"], "whole build context", id="copy-everything"),
    pytest.param("jobs", False, ['COPY ["core", \\', '     "ideas", \\', '     "/app/source/"]'], "takes ideas/",
                 id="json-continuation"),
    pytest.param(None, False, ["ADD ideas /x"], "takes ideas/", id="add-ideas"),
    pytest.param(None, False, ["COPY --chown=1:1 ./ideas/ /x"], "takes ideas/", id="chown-dot-slash"),
    pytest.param(None, False, ["COPY core/../ideas /x"], "takes ideas/", id="dot-dot"),
    pytest.param(None, False, ["COPY /ideas /x"], "takes ideas/", id="leading-slash"),
    pytest.param(None, False, ["copy Ideas /x"], "takes ideas/", id="lower-case"),
    pytest.param(None, False, ["ONBUILD COPY ideas /x"], "takes ideas/", id="onbuild"),
    pytest.param(None, False, ["COPY core \\", "# keep ideas out", "    ideas /x"], "takes ideas/",
                 id="comment-in-continuation"),
    pytest.param(None, False, ["COPY * /x"], "wildcard", id="star"),
    pytest.param(None, False, ["COPY i* /x"], "wildcard", id="i-star"),
    pytest.param(None, False, ["COPY ./ /x"], "whole build context", id="dot-slash"),
    pytest.param(None, False, ["ARG SRC=ideas", "COPY ${SRC} /x"], "variables", id="variable"),
    pytest.param(None, False, ["RUN --mount=target=/src cp -r /src /app"], "whole build context",
                 id="bind-mount-default"),
    pytest.param(None, False, ["RUN --mount=type=bind,source=ideas,target=/s true"], "takes ideas/",
                 id="bind-mount-ideas"),
    pytest.param(None, False, ["COPY [core, /x]"], "isn't valid JSON", id="bad-json"),
    pytest.param(None, False, ['COPY --chown="x --from=y" ideas /x'], "quoted", id="quoted-flag"),
    pytest.param(None, False, ["COPY <<EOF /x", "hi", "EOF"], "heredoc", id="heredoc"),
    pytest.param("jobs", True, ["# escape=`"], "escape=", id="escape-directive"),
    pytest.param("jobs", True, ["# syntax=example/frontend"], "syntax=", id="other-frontend"),
    pytest.param("jobs", True, ["#!/usr/bin/env buildctl", "# syntax=example/frontend"], "frontend", id="shebang"),
    pytest.param("jobs", True, ["//syntax=example/frontend"], "frontend", id="slash-directive"),
    # These must pass.
    pytest.param("jobs", False, [], None, id="jobs-real-file"),
    pytest.param("web", False, [], None, id="web-real-file"),
    pytest.param("web", False, ["# ideas/ stays out of this image."], None, id="comment"),
    pytest.param(None, False, ["COPY --from=build /app/dist /srv"], None, id="other-stage"),
    pytest.param(None, False, ["RUN echo ideas"], None, id="run-echo"),
    pytest.param(None, False, ["RUN --mount=type=cache,target=/root/.npm npm ci"], None, id="cache-mount"),
    pytest.param(None, False, ['COPY ["app/src/ideas.ts", "/x"]'], None, id="file-named-ideas"),
    pytest.param(None, False, ["ADD https://example.com/ideas.tar.gz /x"], None, id="add-url"),
]


def _expect(problems: list[str], expect: str | None) -> None:
    if expect is None:
        assert not problems, "\n".join(problems)
    else:
        assert any(expect in problem for problem in problems), f"expected {expect!r} in:\n" + "\n".join(problems)


@pytest.mark.parametrize("mutate, extra, expect", CODEQL_CASES)
def test_codeql_guard_regressions(mutate, extra, expect):
    text = mutate((ROOT / CODEQL_WORKFLOW).read_text(encoding="utf-8"))
    ideas = [rel(p) for p in files_under(IDEAS)]
    _expect(codeql_scope_problems({CODEQL_WORKFLOW: text}, ideas, lambda p: extra.get(p, read_repo_file(p))), expect)


@pytest.mark.parametrize("base, before, lines, expect", DOCKER_CASES)
def test_docker_guard_regressions(base, before, lines, expect):
    _expect(dockerfile_problems(_dockerfile(base, lines, before)), expect)
