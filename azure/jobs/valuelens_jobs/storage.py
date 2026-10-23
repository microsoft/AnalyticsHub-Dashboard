"""Data stores. Every path is relative and POSIX-style, e.g. `raw/copilot_org_data/part-0.parquet`.

The first segment is the ADLS container (raw, curated, landing). Jobs work on a local copy
(`store.root`): `pull` brings a prefix down, `push` sends written files back up. `LocalStore`
is the same layout on disk, for `--data-dir` runs and tests, where pull and push do nothing.
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import tempfile
import time
from pathlib import Path

log = logging.getLogger("valuelens_jobs.storage")
# Lease Blob's error codes when another lease holds the blob.
LEASE_TAKEN = ("LeaseAlreadyPresent", "LeaseIsBreakingAndCannotBeAcquired")


class LeaseHeld(Exception):
    """Another holder has the lease on `rel`. `holder` is what that holder recorded about itself, or {}."""

    def __init__(self, rel: str, holder=None):
        super().__init__(f"{rel} is leased by another holder")
        self.rel = rel
        self.holder = holder if isinstance(holder, dict) else {}


class LocalStore:
    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def path(self, rel: str) -> Path:
        return self.root / rel

    def pull(self, prefix: str) -> list[str]:
        return self.list(prefix)

    def push(self, rels) -> None:
        pass

    def evict(self, prefix: str) -> None:
        """Free the local copy of `prefix`. Here the local folder is the store, so it stays."""

    def list(self, prefix: str) -> list[str]:
        base = self.root / prefix
        if base.is_file():
            return [prefix]
        if not base.is_dir():
            return []
        return sorted(p.relative_to(self.root).as_posix() for p in base.rglob("*") if p.is_file())

    def remove(self, rels) -> None:
        for rel in rels:
            p = self.root / rel
            if p.is_file():
                p.unlink()

    def read_json(self, rel: str, default=None):
        self.pull(rel)
        p = self.path(rel)
        if not p.is_file():
            return default
        return json.loads(p.read_text(encoding="utf-8"))

    def write_json(self, rel: str, data) -> None:
        p = self.path(rel)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(p.suffix + ".tmp")
        tmp.write_text(json.dumps(data, indent=2, sort_keys=True, default=str), encoding="utf-8")
        tmp.replace(p)
        self.push([rel])

    def acquire_lease(self, rel: str, lease_id: str, seconds: float, holder=None):
        """Leases `rel` to `lease_id` for `seconds`, recording `holder` in it. The same ID takes its own lease back;
        another gets LeaseHeld until the lease is released or lapses. Returns the lease, to renew and release.

        Here a file stands in for AdlsStore's blob lease, for tests and local runs. Between processes on one folder
        it's best effort: two that find a lapsed lease at the same moment can both take it.
        """
        p = self.path(rel)
        p.parent.mkdir(parents=True, exist_ok=True)
        record = {"id": lease_id, "expires": time.time() + seconds, "holder": holder or {}}
        try:
            fd = os.open(p, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            current = _file_lease(p, seconds)
            if current["id"] != lease_id and current["expires"] > time.time():
                raise LeaseHeld(rel, current["holder"]) from None
            # This holder's own lease (a retry), or a lapsed one.
            _write_file_lease(p, record)
        else:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(record, fh)
        return _FileLease(p, lease_id, seconds)


def _file_lease(p: Path, seconds: float) -> dict:
    """LocalStore's lease record in `p`. One that can't be read (being written, or left half-written) counts as held
    until `seconds` after the file last changed."""
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        return {"id": data["id"], "expires": float(data["expires"]), "holder": data.get("holder") or {}}
    except FileNotFoundError:
        return {"id": None, "expires": 0.0, "holder": {}}
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        try:
            changed = p.stat().st_mtime
        except OSError:
            changed = 0.0
        return {"id": None, "expires": changed + seconds, "holder": {}}


def _write_file_lease(p: Path, record: dict) -> None:
    tmp = p.with_name(f"{p.name}.{record['id']}.tmp")
    tmp.write_text(json.dumps(record), encoding="utf-8")
    tmp.replace(p)


class _FileLease:
    """LocalStore's lease, renewed and released like the blob SDK's BlobLeaseClient."""

    def __init__(self, path: Path, lease_id: str, seconds: float):
        self.id, self._path, self._seconds = lease_id, path, seconds

    def renew(self) -> None:
        current = _file_lease(self._path, self._seconds)
        if current["id"] != self.id:
            raise RuntimeError(f"the lease on {self._path.name} was lost")
        _write_file_lease(self._path, dict(current, expires=time.time() + self._seconds))

    def release(self) -> None:
        if _file_lease(self._path, self._seconds)["id"] == self.id:
            self._path.unlink(missing_ok=True)


def _storage_error(exc, codes, status) -> bool:
    """Whether `exc` is a storage error with one of `codes`, or `status` when it carries no error code. The SDK's
    codes are a str Enum, which equals its value but doesn't hash like it, so compare values."""
    code = getattr(exc, "error_code", None)
    code = getattr(code, "value", code)
    if code:
        return code in codes
    return getattr(exc, "status_code", None) == status


def _blob_json(blob) -> dict:
    """The JSON object in `blob`, or {} when it can't be read."""
    try:
        data = json.loads(blob.download_blob().readall() or b"{}")
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


class AdlsStore(LocalStore):
    """Blob-endpoint access with the job's managed identity (shared-key access is disabled)."""

    def __init__(self, account: str, credential=None, root=None, service=None):
        super().__init__(root or tempfile.mkdtemp(prefix="valuelens-"))
        if service is None:
            from azure.identity import DefaultAzureCredential
            from azure.storage.blob import BlobServiceClient

            service = BlobServiceClient(f"https://{account}.blob.core.windows.net",
                                        credential=credential or DefaultAzureCredential())
        self._service = service

    @staticmethod
    def _split(rel: str):
        container, _, name = rel.strip("/").partition("/")
        return container, name

    def _container(self, name):
        return self._service.get_container_client(name)

    def _blobs(self, prefix: str) -> list[tuple[str, object]]:
        """[(path, last modified)] under `prefix`, by path."""
        container, name = self._split(prefix)
        # Hierarchical-namespace accounts also list directories, as empty blobs marked hdi_isfolder.
        blobs = self._container(container).list_blobs(name_starts_with=name, include=["metadata"])
        return sorted(((f"{container}/{b.name}", getattr(b, "last_modified", None)) for b in blobs
                       if (b.metadata or {}).get("hdi_isfolder") != "true"
                       and (b.name == name or not name or b.name.startswith(name.rstrip("/") + "/"))),
                      key=lambda blob: blob[0])

    def list(self, prefix: str) -> list[str]:
        return [rel for rel, _ in self._blobs(prefix)]

    def pull(self, prefix: str) -> list[str]:
        blobs = self._blobs(prefix)
        local = self.root / prefix
        if local.is_dir():
            shutil.rmtree(local)
        for rel, modified in blobs:
            container, name = self._split(rel)
            target = self.path(rel)
            target.parent.mkdir(parents=True, exist_ok=True)
            with open(target, "wb") as fh:
                self._container(container).download_blob(name).readinto(fh)
            if modified is not None:
                # The upload time, not the download time: the drop folder picks the newest upload by it.
                os.utime(target, (modified.timestamp(), modified.timestamp()))
        log.info("pulled %s file(s) under %s", len(blobs), prefix)
        return [rel for rel, _ in blobs]

    def push(self, rels) -> None:
        for rel in rels:
            container, name = self._split(rel)
            with open(self.path(rel), "rb") as fh:
                self._container(container).upload_blob(name, fh, overwrite=True)

    def evict(self, prefix: str) -> None:
        """Free the local copy of `prefix`, leaving the blobs: `pull` brings it back."""
        shutil.rmtree(self.root / prefix, ignore_errors=True)

    def remove(self, rels) -> None:
        for rel in rels:
            container, name = self._split(rel)
            try:
                self._container(container).delete_blob(name)
            except Exception as exc:  # already gone is fine
                if "BlobNotFound" not in str(exc) and "404" not in str(exc):
                    raise
        super().remove(rels)

    def acquire_lease(self, rel: str, lease_id: str, seconds: float, holder=None):
        """Leases the blob `rel` to `lease_id` for `seconds` (15 to 60), creating the blob when it's missing, and
        records `holder` in it. The same ID takes its own lease back; another gets LeaseHeld until the lease is
        released or lapses. Returns the SDK's BlobLeaseClient, which renews and releases it."""
        container, name = self._split(rel)
        blob = self._container(container).get_blob_client(name)

        def acquire():
            try:
                return blob.acquire_lease(lease_duration=int(seconds), lease_id=lease_id)
            except Exception as exc:
                if _storage_error(exc, LEASE_TAKEN, 409):
                    raise LeaseHeld(rel, _blob_json(blob)) from None
                raise

        try:
            lease = acquire()
        except Exception as exc:
            if not _storage_error(exc, ("BlobNotFound",), 404):
                raise
            try:
                # If-None-Match: *, so a blob another holder has just created is left as it is.
                blob.upload_blob(b"", overwrite=False)
            except Exception as created:
                if getattr(created, "status_code", None) not in (409, 412):
                    raise
            lease = acquire()
        if holder:
            try:
                blob.upload_blob(json.dumps(holder, sort_keys=True, default=str).encode("utf-8"), overwrite=True,
                                 lease=lease)
            except Exception as exc:
                log.warning("couldn't record the lease's holder in %s (%s)", rel, exc)
        return lease


def open_store(data_dir, settings):
    if data_dir:
        return LocalStore(data_dir)
    if not settings.storage_account:
        raise ValueError("Set --data-dir or VALUELENS_STORAGE_ACCOUNT.")
    return AdlsStore(settings.storage_account)
