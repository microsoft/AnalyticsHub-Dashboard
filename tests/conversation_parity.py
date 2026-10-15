"""Synthetic parsed-input cross-month check; runnable with local Spark or a Fabric Spark session.

No production tables, credentials, or writes are used. In Fabric, call run_spark(spark).
The fixture runs the actual processor cells, then the notebook's incremental dependency
helper. Delta/SQL publishing and semantic-model equality are separate validation gates.
"""
from __future__ import annotations

import ast
import datetime
import json
from pathlib import Path
import uuid

ROOT = Path(__file__).resolve().parents[1]
NOTEBOOK = ROOT / "fabric" / "notebooks" / "Copilot_Audit_Log_Processor.ipynb"
COLUMNS = [
    "Id", "CreationDate", "Audit_UserId", "AppHost", "ThreadId", "Message_Id",
    "Message_isPrompt", "AccessedResource_Type", "AccessedResource_Action",
    "ModelTransparencyDetails_ModelName",
]


def fixture(stage=0):
    def row(key, date, thread, message, resource):
        return [key, date + "T12:00:00Z", "person@example.invalid", "Cowork", thread,
                message, "true", resource, "read", "gpt-5"]

    rows = [
        row("a", "2026-07-30", "Thread-A", "Message-A", "message"),
        row("b", "2026-08-01", "Thread-B", "message-a", "application/pdf"),
        row("c", "2026-06-02", "thread-b", "Message-C", "text/plain"),
        row("d", "2026-05-01", "Independent", "Independent", "message"),
        row("null-old", "2026-07-03", None, None, "message"),
        row("empty-old", "2026-07-04", "", "", "message"),
    ]
    if stage in (1, 2):
        rows.extend([
            row("new", "2026-10-01", "thread-a", "MESSAGE-A" if stage == 1 else "Changed-ID", "text/markdown"),
            row("null-new", "2026-10-02", None, None, "application/json"),
            row("empty-new", "2026-10-03", "", "", "text/markdown"),
        ])
    return rows


def spark_curate(spark, rows):
    """Execute the real notebook transform cells against a temporary parsed table."""
    name = "conversation_fixture_" + uuid.uuid4().hex
    quote = lambda v: "CAST(NULL AS STRING)" if v is None else "'" + str(v).replace("'", "''") + "'"
    values = ", ".join("(" + ", ".join(quote(v) for v in row) + ")" for row in rows)
    source = spark.sql(f"SELECT * FROM VALUES {values} AS src({', '.join(COLUMNS)})")
    source.createOrReplaceTempView(name)
    nb = json.loads(NOTEBOOK.read_text(encoding="utf-8"))
    ns = {"spark": spark}
    try:
        for index, cell in enumerate(nb["cells"][:15]):
            if cell["cell_type"] != "code":
                continue
            exec(compile("".join(cell["source"]), f"processor:cell{index}", "exec"), ns)
            if index == 1:
                ns.update(SRC_INTERACTIONS=name, SRC_LICENSED=name + "_absent_licenses",
                          SRC_AGENTS=name + "_absent_agents", OUT_TABLE=name + "_unused_output",
                          AGENT_TYPE_OVERRIDES_TABLE=None, WRITE_MODE="overwrite")
        return ns["fact"].localCheckpoint(eager=True), ns
    finally:
        spark.catalog.dropTempView(name)


def run_spark(spark):
    from pyspark.sql import functions as F

    previous, ns = spark_curate(spark, fixture())
    results = []
    # Append across months; change an ID; delete the new month entirely.
    for stage in (1, 2, 3):
        full, ns = spark_curate(spark, fixture(stage))
        new_rows = [r for r in fixture(stage) if r[1].startswith("2026-10")]
        replacement = spark_curate(spark, new_rows)[0] if new_rows else full.limit(0)
        rewritten, months = ns["update_conversation_history"](replacement, previous, ["2026-10"])
        predicate = F.expr(ns["month_predicate_sql"]("MonthStart", months))
        actual = previous.where(~predicate).unionByName(rewritten).localCheckpoint(eager=True)
        columns = ["Id", *ns["SLIM_COLS"]]
        projection = [F.col(f"`{c}`") for c in columns]
        got = [tuple(r) for r in actual.select(*projection).orderBy("Id").collect()]
        expected = [tuple(r) for r in full.select(*projection).orderBy("Id").collect()]
        if got != expected:
            mismatch = next(((a, b) for a, b in zip(got, expected) if a != b), (len(got), len(expected)))
            raise AssertionError(f"Spark stage {stage} incremental != full: {mismatch}")
        if "2026-05" in months:
            raise AssertionError("Independent month was needlessly rewritten")
        # Row b shares the changed message, not the changed thread: its thread still
        # includes row c, which is outside the affected working set.
        band = actual.where("Id = 'b'").select("Session Turn Band").first()[0]
        if band != "2-3 turns":
            raise AssertionError(f"Partly included, unaffected thread was changed: {band}")
        writer = "".join(json.loads(NOTEBOOK.read_text(encoding="utf-8"))["cells"][15]["source"])
        definition = next(n for n in ast.parse(writer).body
                          if isinstance(n, ast.FunctionDef) and n.name == "historical_audit_changed")
        exec(compile(ast.Module(body=[definition], type_ignores=[]), "processor:refresh-check", "exec"), ns)
        previous.createOrReplaceTempView(ns["OUT_TABLE"])
        try:
            changed = ns["historical_audit_changed"](
                rewritten, {"full": False, "months": months}, datetime.date(2026, 10, 4))
            if not changed:
                raise AssertionError("Historical conversation updates did not request model refresh")
            unchanged = previous.where(predicate)
            if ns["historical_audit_changed"](
                    unchanged, {"full": False, "months": months}, datetime.date(2026, 10, 4)):
                raise AssertionError("Unchanged historical rows needlessly request full refresh")
        finally:
            spark.catalog.dropTempView(ns["OUT_TABLE"])
        results.append({"stage": stage, "rows": len(expected), "rewritten_months": months,
                        "historical_refresh": changed})
        previous = actual
    return results


if __name__ == "__main__":
    from valuelens_golden import spark_session

    print(json.dumps(run_spark(spark_session()), indent=2))
