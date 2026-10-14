"""Publish docs/ to the GitHub wiki.

docs/ is the source of truth, reviewed in pull requests. This writes each page under its wiki
name, rewrites relative links for the wiki, and removes pages it published before that no longer
exist. It only writes files: the workflow commits and pushes them.

    python .github/scripts/publish_wiki.py --out wiki --repo owner/name --ref main
"""
from __future__ import annotations

import argparse
import posixpath
import re
from pathlib import Path
from urllib.parse import quote, unquote

ROOT = Path(__file__).resolve().parents[2]

# Source file (relative to the repo root) -> wiki page name.
PAGES = {
    "docs/wiki/Home.md": "Home",
    "docs/wiki/_Sidebar.md": "_Sidebar",
    "docs/PREREQUISITES.md": "Prerequisites",
    "docs/INSTALL.md": "Install",
    "docs/VERIFY.md": "Verify",
    "docs/UPDATE.md": "Update",
    "docs/UNINSTALL.md": "Uninstall",
    "docs/TROUBLESHOOTING.md": "Troubleshooting",
    "docs/KNOWN-ISSUES.md": "Known-Issues",
    "docs/ARCHITECTURE.md": "Architecture-and-Costs",
    "docs/PERMISSIONS.md": "Permissions",
    "docs/APP-GUIDE.md": "App-Guide",
    "docs/METHODOLOGY.md": "Methodology",
    "docs/DATA-DICTIONARY.md": "Data-Dictionary",
}

MARKER = "<!-- published from docs/ by .github/workflows/wiki.yml -->"
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".mp4"}

# [text](target) and ![alt](target), with an optional "title".
MD_LINK = re.compile(r'(!?)\[((?:[^\[\]]|\[[^\]]*\])*)\]\(\s*<?([^)\s>]+)>?(\s+"[^"]*")?\s*\)')
HTML_ATTR = re.compile(r'\b(href|src)="([^"]+)"')
FENCE = re.compile(r"^(```|~~~)", re.M)


def rewrite_target(target: str, source: str, repo: str, ref: str, image: bool = False) -> str:
    """Rewrite one link target found in `source` (a repo-relative path) for the wiki."""
    if re.match(r"^[a-z][a-z0-9+.-]*:", target, re.I) or target.startswith(("#", "//")):
        return target
    path, _, anchor = target.partition("#")
    anchor = f"#{anchor}" if anchor else ""
    resolved = posixpath.normpath(posixpath.join(posixpath.dirname(source), unquote(path)))
    if resolved == ".":
        resolved = ""
    if resolved in PAGES:
        return PAGES[resolved] + anchor
    url_path = quote(resolved, safe="/")
    if image or posixpath.splitext(resolved)[1].lower() in IMAGE_EXT:
        return f"https://github.com/{repo}/raw/{ref}/{url_path}"
    kind = "tree" if (ROOT / resolved).is_dir() or not resolved else "blob"
    return f"https://github.com/{repo}/{kind}/{ref}/{url_path}".rstrip("/") + anchor


def rewrite(text: str, source: str, repo: str, ref: str) -> str:
    """Rewrite every relative link in `text`, leaving fenced code blocks alone."""
    def md(m: re.Match) -> str:
        bang, label, target, title = m.group(1), m.group(2), m.group(3), m.group(4) or ""
        return f"{bang}[{label}]({rewrite_target(target, source, repo, ref, bool(bang))}{title})"

    def html(m: re.Match) -> str:
        return f'{m.group(1)}="{rewrite_target(m.group(2), source, repo, ref, m.group(1) == "src")}"'

    parts = FENCE.split(text)
    out, in_code, i = [], False, 0
    # FENCE.split keeps the delimiters: [text, fence, text, fence, ...].
    while i < len(parts):
        chunk = parts[i]
        if i % 2 == 1:
            out.append(chunk)
            in_code = not in_code
        elif in_code:
            out.append(chunk)
        else:
            out.append(HTML_ATTR.sub(html, MD_LINK.sub(md, chunk)))
        i += 1
    return "".join(out)


def page(source: str, repo: str, ref: str) -> str:
    text = (ROOT / source).read_text(encoding="utf-8").replace("\r\n", "\n")
    body = rewrite(text, source, repo, ref).rstrip("\n")
    if PAGES[source].startswith("_"):
        return f"{MARKER}\n{body}\n"
    edit = f"https://github.com/{repo}/blob/{ref}/{quote(source)}"
    return f"{MARKER}\n{body}\n\n---\n\n*Published from [{source}]({edit}). To change this page, edit that file in a pull request.*\n"


def publish(out: Path, repo: str, ref: str) -> list[str]:
    out.mkdir(parents=True, exist_ok=True)
    written = []
    for source, name in PAGES.items():
        target = out / f"{name}.md"
        target.write_text(page(source, repo, ref), encoding="utf-8", newline="\n")
        written.append(target.name)
    for old in out.glob("*.md"):
        if old.name not in written and MARKER in old.read_text(encoding="utf-8", errors="ignore"):
            old.unlink()
    return written


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", required=True, type=Path, help="The cloned wiki folder.")
    parser.add_argument("--repo", default="microsoft/AnalyticsHub-Dashboard")
    parser.add_argument("--ref", default="main")
    args = parser.parse_args()
    for name in publish(args.out, args.repo, args.ref):
        print(name)


if __name__ == "__main__":
    main()
