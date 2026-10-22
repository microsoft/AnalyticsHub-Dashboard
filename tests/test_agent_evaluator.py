"""Checks for the optional Agent Evaluator template."""
import ast
import contextlib
import io
import json
import re
import sys
import types
import unittest
import zipfile
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
PBIT = ROOT / "fabric" / "Add Agent Evaluator" / "Agent Evaluator.pbit"
NOTEBOOK = ROOT / "fabric" / "notebooks" / "agent-evaluator" / "Copilot_Agent_Transcript_Parser.ipynb"
AGENT_TABLES = [
    "dbo.agent_sessions",
    "dbo.agent_turns",
    "dbo.agent_errors",
    "dbo.agent_subagents",
    "dbo.agent_catalogue",
    "dbo.agent_performance",
]


def measures():
    with zipfile.ZipFile(PBIT) as archive:
        model = json.loads(archive.read("DataModelSchema").decode("utf-16-le"))
    found = {}
    for table in model["model"]["tables"]:
        for measure in table.get("measures", []):
            expression = measure["expression"]
            found[measure["name"]] = "\n".join(expression) if isinstance(expression, list) else expression
    return found


def notebook_cells():
    return json.loads(NOTEBOOK.read_text(encoding="utf-8"))["cells"]


def notebook_cell_source(needle):
    for cell in notebook_cells():
        source = "".join(cell.get("source", []))
        if needle in source:
            return source
    raise AssertionError(f"Notebook cell not found: {needle}")


class FakeStringType:
    pass


class FakeStructField:
    def __init__(self, name, data_type, nullable):
        self.name = name
        self.data_type = data_type
        self.nullable = nullable


class FakeStructType:
    def __init__(self, fields):
        self.fields = list(fields)


class FakeCatalog:
    def __init__(self, existing):
        self.existing = set(existing)
        self.lookups = []

    def tableExists(self, table):
        self.lookups.append(table)
        return table in self.existing


class FakeWriter:
    def __init__(self, spark, frame):
        self.spark = spark
        self.frame = frame
        self.mode_value = None
        self.format_value = None
        self.options = {}

    def mode(self, value):
        self.mode_value = value
        return self

    def option(self, key, value):
        self.options[key] = value
        return self

    def format(self, value):
        self.format_value = value
        return self

    def saveAsTable(self, table):
        self.spark.saves.append({
            "table": table,
            "mode": self.mode_value,
            "format": self.format_value,
            "options": dict(self.options),
            "schema": self.frame.schema,
            "rows": self.frame.rows,
        })


class FakeFrame:
    def __init__(self, spark, rows, schema):
        self.spark = spark
        self.rows = rows
        self.schema = schema
        self.columns = [field.name for field in schema.fields]

    @property
    def write(self):
        return FakeWriter(self.spark, self)


class FakeSpark:
    def __init__(self, existing=()):
        self.catalog = FakeCatalog(existing)
        self.created = []
        self.saves = []
        self.sqls = []
        self.fail_sql = ()

    def createDataFrame(self, rows, schema=None):
        self.created.append({"rows": rows, "schema": schema})
        return FakeFrame(self, rows, schema)

    def sql(self, statement):
        self.sqls.append(statement)
        if any(table in statement for table in self.fail_sql):
            raise RuntimeError("compaction is busy")


@contextlib.contextmanager
def fake_pyspark_types():
    module_names = ["pyspark", "pyspark.sql", "pyspark.sql.types"]
    previous = {name: sys.modules.get(name) for name in module_names}
    pyspark = types.ModuleType("pyspark")
    sql = types.ModuleType("pyspark.sql")
    sql_types = types.ModuleType("pyspark.sql.types")
    sql_types.StructType = FakeStructType
    sql_types.StructField = FakeStructField
    sql_types.StringType = FakeStringType
    pyspark.sql = sql
    sql.types = sql_types
    sys.modules.update({
        "pyspark": pyspark,
        "pyspark.sql": sql,
        "pyspark.sql.types": sql_types,
    })
    try:
        yield
    finally:
        for name, module in previous.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module


def helper_namespace(spark):
    source = notebook_cell_source("def _write_empty_delta_table_if_needed")
    tree = ast.parse(source)
    helper = [
        node for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name == "_write_empty_delta_table_if_needed"
    ]
    ns = {"spark": spark}
    exec(compile(ast.Module(body=helper, type_ignores=[]), "agent-evaluator-helper", "exec"), ns)
    return ns


class FakeOutputFrame:
    """Stands in for one of the parsed Spark DataFrames the writer cell receives."""

    def __init__(self, columns, rows=0, spark=None):
        self.columns = list(columns)
        self.rows = rows
        self.schema = None
        self.spark = spark

    def count(self):
        return self.rows

    @property
    def write(self):
        return FakeWriter(self.spark, self)


def run_agent_writer_cell(write_mode, existing=(), rows=0, spark=None, **settings):
    spark = spark or FakeSpark(existing)
    ns = helper_namespace(spark)

    def frame(columns):
        return FakeOutputFrame(columns, rows, spark)

    ns.update({
        "spark": spark,
        "WRITE_MODE": write_mode,
        "OUTPUT_PREFIX": "dbo",
        "RAW_TABLE": "dbo.conversationtranscripts_raw",
        "RUN_OPTIMIZE": True,
        "sessions": frame(["conversation_id", "agent_name"]),
        "turns": frame(["turn_id"]),
        "errors": frame(["conversation_id", "error_timestamp_utc", "error_code"]),
        "subagents": frame([
            "conversation_id", "invocation_timestamp_utc", "connected_agent_schema", "plan_step_id",
        ]),
        "agent_dim": frame(["agent_schema"]),
        "agent_performance": frame(["ConversationTranscriptId"]),
    })
    ns.update(settings)
    source = notebook_cell_source("for name, pdf in outputs.items():")
    output = io.StringIO()
    with fake_pyspark_types(), contextlib.redirect_stdout(output):
        exec(compile(source, "agent-evaluator-writer-cell", "exec"), ns)
    return spark, output.getvalue()


class AgentEvaluatorTemplateTests(unittest.TestCase):
    def test_answered_rate_is_the_complement_of_the_gap_rate(self):
        # Both are shares of knowledge searches, so Answered + Gap = 100%. Answered
        # used to divide by every session, and Focus 2 subtracted the two shares.
        found = measures()
        self.assertIn("1 - [Knowledge Gap Rate]", found["Knowledge Answered Rate"])
        self.assertIn("'Agent Sessions'[knowledge_searched] = TRUE ()", found["Knowledge Gap Rate"])
        self.assertIn("VAR gap = [Knowledge Gap Rate]", found["⭐ Focus 2: Knowledge Gap"])


class AgentEvaluatorNotebookWriteTests(unittest.TestCase):
    def test_zero_row_merge_and_append_create_missing_tables_or_leave_existing_unchanged(self):
        for write_mode in ("merge", "append"):
            with self.subTest(write_mode=write_mode, existing=False):
                spark, output = run_agent_writer_cell(write_mode, existing=())
                self.assertEqual(AGENT_TABLES, [save["table"] for save in spark.saves])
                self.assertTrue(all(save["mode"] == "append" for save in spark.saves))
                self.assertEqual(
                    ["conversation_id", "agent_name"],
                    [field.name for field in spark.saves[0]["schema"].fields],
                )
                self.assertIn("created empty (no rows)", output)
                self.assertNotIn("merge(no-rows)", output)

            with self.subTest(write_mode=write_mode, existing=True):
                spark, output = run_agent_writer_cell(write_mode, existing=AGENT_TABLES)
                self.assertEqual([], spark.saves)
                self.assertEqual([], spark.created)
                self.assertEqual(AGENT_TABLES, spark.catalog.lookups)
                self.assertIn("unchanged (no rows)", output)

    def test_tables_written_this_run_are_compacted_once_at_the_end(self):
        for write_mode in ("append", "overwrite"):
            with self.subTest(write_mode=write_mode):
                spark, output = run_agent_writer_cell(write_mode, rows=5)
                self.assertEqual(AGENT_TABLES, [save["table"] for save in spark.saves])
                optimize = [s for s in spark.sqls if s.startswith("OPTIMIZE")]
                self.assertEqual([f"OPTIMIZE {t} VORDER" for t in AGENT_TABLES], optimize)
                self.assertGreater(spark.sqls.index(optimize[0]), max(
                    (i for i, s in enumerate(spark.sqls) if s.startswith("DROP")), default=-1))
                self.assertEqual(6, output.count("compacted (OPTIMIZE VORDER)"))

    def test_the_raw_table_is_compacted_only_when_this_run_wrote_it(self):
        spark, _ = run_agent_writer_cell("append", rows=5, _raw_writes=1)
        self.assertEqual("OPTIMIZE dbo.conversationtranscripts_raw VORDER", spark.sqls[-1])
        spark, _ = run_agent_writer_cell("append", rows=5, _raw_writes=1, RAW_TABLE="")
        self.assertNotIn("raw", " ".join(spark.sqls))
        spark, _ = run_agent_writer_cell("append", rows=5, _raw_writes=0)
        self.assertNotIn("raw", " ".join(spark.sqls))

    def test_empty_or_unchanged_tables_are_not_compacted(self):
        for write_mode, existing in (("append", ()), ("merge", AGENT_TABLES), ("overwrite", ())):
            with self.subTest(write_mode=write_mode, existing=bool(existing)):
                spark, output = run_agent_writer_cell(write_mode, existing=existing)
                self.assertFalse([s for s in spark.sqls if s.startswith("OPTIMIZE")])
                self.assertNotIn("compacted", output)

    def test_compaction_can_be_turned_off(self):
        spark, output = run_agent_writer_cell("append", rows=5, RUN_OPTIMIZE=False)
        self.assertEqual(AGENT_TABLES, [save["table"] for save in spark.saves])
        self.assertFalse([s for s in spark.sqls if s.startswith("OPTIMIZE")])

    def test_a_failed_compaction_never_fails_the_load(self):
        spark = FakeSpark()
        spark.fail_sql = ("dbo.agent_turns",)
        spark, output = run_agent_writer_cell("append", rows=5, spark=spark)
        self.assertEqual(len(AGENT_TABLES), len([s for s in spark.sqls if s.startswith("OPTIMIZE")]))
        self.assertIn("! dbo.agent_turns: not compacted (RuntimeError: compaction is busy)", output)
        self.assertEqual(5, output.count("compacted (OPTIMIZE VORDER)"))

    def test_run_optimize_is_a_config_setting(self):
        self.assertRegex(notebook_cell_source("# === CONFIG ==="), r"(?m)^RUN_OPTIMIZE\s+= True\b")

    def test_zero_row_notebook_messages_are_accurate(self):
        text = NOTEBOOK.read_text(encoding="utf-8")
        self.assertNotIn("writing empty agent tables (schema preserved)", text)
        self.assertNotIn("merge(no-rows)", text)
        self.assertNotIn("if RAW_TABLE and len(tx):", text)
        self.assertIn(
            "agent tables will be created empty if missing; existing tables are left unchanged in merge/append mode",
            text,
        )
        self.assertIn("created empty (no rows)", text)
        self.assertIn("unchanged (no rows)", text)
        self.assertIn("overwritten empty", text)


def exec_top_level(needle, ns, assigns=None):
    """Run a cell's imports, function definitions and (optionally only the named) assignments."""
    tree = ast.parse(notebook_cell_source(needle))
    keep = []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef):
            keep.append(node)
        elif isinstance(node, ast.Import):
            if not any(alias.name.startswith("pyspark") for alias in node.names):
                keep.append(node)
        elif isinstance(node, ast.ImportFrom):
            if not (node.module or "").startswith("pyspark"):
                keep.append(node)
        elif isinstance(node, ast.Assign):
            names = [t.id for t in node.targets if isinstance(t, ast.Name)]
            if assigns is None or (names and all(n in assigns for n in names)):
                keep.append(node)
    exec(compile(ast.Module(body=keep, type_ignores=[]), f"agent-evaluator:{needle}", "exec"), ns)
    return ns


def transcript_parse_namespace():
    ns = {"TEXT_TRUNCATE": 500}
    exec_top_level("def parsed_transcript_frame", ns, assigns={"_TRANSCRIPT_ID_RE"})
    for needle in ("def keep_user_id", "def build_sessions", "def build_turns", "def build_errors",
                   "def build_agent_dim", "def build_agent_performance"):
        exec_top_level(needle, ns)
    exec_top_level("def transcript_output_rows", ns, assigns={"_OUTPUT_BUILDERS", "_OUT_WS"})
    exec_top_level("def staged_transcript_record", ns, assigns=set())
    return ns


USER_A = "11111111-1111-1111-1111-111111111111"
USER_B = "22222222-2222-2222-2222-222222222222"
USER_C = "33333333-3333-3333-3333-333333333333"


def dataverse_transcript(n, user, *, env_bot="crb_helpdesk", error=False, connected=None, text="hello"):
    """One conversationtranscripts row as the Dataverse Web API returns it."""
    start = 1_700_000_000_000 + n * 60_000
    acts = [
        {"type": "message", "timestampMs": start, "text": f"{text}\nline two\t{n}",
         "from": {"role": 0, "aadObjectId": user}, "recipient": {"name": "Helpdesk", "id": "bot-1"}},
        {"type": "message", "timestampMs": start + 1500, "text": "Here you go.",
         "from": {"role": 1, "name": "Helpdesk", "id": "bot-1"}},
    ]
    if error:
        acts.append({"type": "trace", "valueType": "ErrorTraceData", "timestampMs": start + 2000,
                     "value": {"errorCode": "SystemError", "errorMessage": "boom"}})
    if connected:
        acts.append({"type": "trace", "valueType": "ConnectedAgentInitializeTraceData", "timestampMs": start + 2500,
                     "value": {"connectedAgentBotSchemaName": connected, "parentBotSchemaName": env_bot}})
    return {
        "@odata.etag": f'W/"{n}"',
        "conversationtranscriptid": f"00000000-0000-0000-0000-{n:012d}",
        "content": json.dumps({"activities": acts}),
        "conversationstarttime": "2024-01-01T00:00:00Z",
        "schemaversion": "1",
        "schematype": "",
        "name": "",
        "metadata": None,
        "statecode": 0,
        "statuscode": 1,
        "createdon": "2024-01-01T00:00:00Z",
        "_bot_conversationtranscriptid_value": "bot-guid",
        "bot_conversationtranscriptid": {"schemaname": env_bot, "name": "Helpdesk", "botid": "bot-1"},
    }


def transcript_fixture(ns):
    """Staged records from two environments: a returning user, one-off users, an error, a sub-agent call and one
    structurally-corrupt row (non-GUID id)."""
    stage = ns["staged_transcript_record"]
    env_a, env_b = "https://a.crm.dynamics.com", "https://b.crm.dynamics.com"
    records = [
        stage(dataverse_transcript(1, USER_A, error=True), env_a),
        stage(dataverse_transcript(2, USER_B, connected="crb_hr"), env_a),
        stage(dataverse_transcript(3, USER_A, text="again"), env_a),
        stage(dataverse_transcript(4, USER_C, env_bot="crb_finance"), env_b),
        stage(dataverse_transcript(5, USER_A, env_bot="crb_finance"), env_b),
    ]
    corrupt = stage(dataverse_transcript(6, USER_B), env_b)
    corrupt["conversationtranscriptid"] = 'role":0}'
    records.append(corrupt)
    return records


def whole_frame_outputs(ns, records):
    """What the notebook produced before: every builder run once over every transcript."""
    parsed, _ = ns["parsed_transcript_frame"](records, "content", "conversationtranscriptid", True)
    env_by_conv = dict(zip(parsed["conversationtranscriptid"], parsed["SourceEnvironment"]))
    out = {}
    for table, build in ns["_OUTPUT_BUILDERS"].items():
        key = "ConversationTranscriptId" if table == "agent_performance" else "conversation_id"
        rows = []
        for row in build(parsed).to_dict("records"):
            row = {k: ns["_out_str"](v) for k, v in row.items()}
            row["source_environment"] = env_by_conv[row[key]]
            rows.append(row)
        out[table] = rows
    return out


def chunked_outputs(ns, records, chunk_rows):
    parse = ns["transcript_partition_parser"](chunk_rows, "content", "conversationtranscriptid", True, True)
    out, stats = {}, None
    for table, payload in parse(iter(records)):
        if table == "_stats":
            stats = json.loads(payload)
        else:
            out.setdefault(table, []).append(json.loads(payload))
    # Cell 8d works out is_returning_user over every session once the chunks are parsed.
    counts = {}
    for row in out.get("agent_sessions", []):
        counts[row["user_id_hash"]] = counts.get(row["user_id_hash"], 0) + 1
    for row in out.get("agent_sessions", []):
        uid = row["user_id_hash"]
        row["is_returning_user"] = "True" if uid and counts[uid] > 1 else "False"
    return out, stats


def canonical(rows):
    return sorted(json.dumps(r, sort_keys=True) for r in rows)


class TranscriptStreamingTests(unittest.TestCase):
    def test_staged_record_is_flat_strings_without_annotations(self):
        ns = transcript_parse_namespace()
        rec = ns["staged_transcript_record"]({
            "@odata.etag": 'W/"1"',
            "ConversationTranscriptId": "abc",
            "_bot_conversationtranscriptid_value": "x",
            "statecode": 0,
            "metadata": None,
            "bot_conversationtranscriptid": {"schemaname": "crb_hr", "name": "HR"},
        }, "https://env")
        self.assertEqual({
            "conversationtranscriptid": "abc",
            "statecode": "0",
            "metadata": "",
            "bot_conversationtranscriptid": '{"name": "HR", "schemaname": "crb_hr"}',
            "SourceEnvironment": "https://env",
        }, rec)
        self.assertNotIn("SourceEnvironment", ns["staged_transcript_record"]({"a": 1}))

    def test_bot_lookup_survives_staging(self):
        ns = transcript_parse_namespace()
        records = [ns["staged_transcript_record"](dataverse_transcript(1, USER_A, env_bot="crb_payroll"))]
        parsed, stats = ns["parsed_transcript_frame"](records, "content", "conversationtranscriptid", True)
        self.assertEqual(["crb_payroll"], list(parsed["agent_schema_hint"]))
        self.assertEqual({"rows": 1, "valid": 1, "corrupt": 0, "hint": 1}, stats)

    def test_chunked_parse_matches_a_single_whole_frame_parse(self):
        ns = transcript_parse_namespace()
        records = transcript_fixture(ns)
        expected = whole_frame_outputs(ns, records)
        self.assertEqual(5, len(expected["agent_sessions"]))
        self.assertTrue(expected["agent_errors"] and expected["agent_subagents"])
        for chunk_rows in (1, 2, 4, 200):
            with self.subTest(chunk_rows=chunk_rows):
                actual, stats = chunked_outputs(ns, records, chunk_rows)
                self.assertEqual({"rows": 6, "valid": 6, "corrupt": 1, "hint": 5}, stats)
                for table, rows in expected.items():
                    self.assertEqual(canonical(rows), canonical(actual.get(table, [])), table)

    def test_returning_user_is_worked_out_across_chunks(self):
        ns = transcript_parse_namespace()
        actual, _ = chunked_outputs(ns, transcript_fixture(ns), 1)
        returning = {r["user_id_hash"]: r["is_returning_user"] for r in actual["agent_sessions"]}
        self.assertEqual({USER_A: "True", USER_B: "False", USER_C: "False"}, returning)

    def test_output_values_are_strings_like_the_old_writer(self):
        out = transcript_parse_namespace()["_out_str"]
        self.assertIsNone(out(None))
        self.assertIsNone(out(float("nan")))
        self.assertEqual("True", out(True))
        self.assertEqual("3", out(3))
        self.assertEqual("3", out(3.0))
        self.assertEqual("2.5", out(2.5))
        self.assertEqual("a b", out(" a\r\n\tb "))

    def test_empty_input_gives_every_builder_column(self):
        ns = transcript_parse_namespace()
        parsed, stats = ns["parsed_transcript_frame"]([], None, None)
        self.assertEqual(0, stats["rows"])
        for table, build in ns["_OUTPUT_BUILDERS"].items():
            self.assertTrue(len(build(parsed).columns) > 0, table)
        self.assertEqual([], [t for t, _ in ns["transcript_output_rows"]([], "content", None, False) if t != "_stats"])

    def test_staging_writes_jsonl_pages_and_clears_them(self):
        import tempfile
        ns = exec_top_level("def _tx_stage_page", {}, assigns=set())
        with tempfile.TemporaryDirectory() as tmp:
            root = ns["_tx_stage_dir"](str(Path(tmp) / "stage"))
            run = ns["_tx_join"](root, "run_1")
            ns["_tx_make_dir"](run)
            page = ns["_tx_join"](run, "part_0000_00000.jsonl")
            ns["_tx_stage_page"](page, [{"a": "1"}, {"a": "é"}])
            self.assertEqual([{"a": "1"}, {"a": "é"}],
                             [json.loads(line) for line in Path(page).read_text(encoding="utf-8").splitlines()])
            ns["_tx_clear_stage"](root)
            self.assertFalse(Path(root).exists())
        self.assertEqual("Files/_transcript_staging", ns["_tx_stage_dir"]("Files/_transcript_staging/"))
        self.assertEqual("Files/x", ns["_tx_stage_dir"]("/lakehouse/default/Files/x"))

    def test_status_counts_distinct_ids_per_environment(self):
        ns = exec_top_level("def evaluator_status_rows", {}, assigns=set())
        rows = ns["evaluator_status_rows"](
            ["https://a/", "https://b"], {"https://a": {"1", "2"}}, {}, [], {"https://a": 7}, {}, "now")
        self.assertEqual((2, "ok"), rows[0][4:6])
        self.assertEqual((0, "empty"), rows[1][4:6])

    def test_one_unreadable_environment_does_not_fail_the_run_when_the_others_are_empty(self):
        # A 403 in one environment and 0 transcripts in the rest is a status row, not "all pulls failed".
        fetch = notebook_cell_source("def staged_transcript_record")
        self.assertIn("if _tasks and len(_errs) == len(_tasks):", fetch)
        self.assertNotIn("if _errs and not _tx_total", fetch)

        class Forbidden(Exception):
            response = type("R", (), {"status_code": 403})()

        ns = exec_top_level("def evaluator_status_rows", {}, assigns=set())
        rows = ns["evaluator_status_rows"](
            ["https://a", "https://b"], {"https://a": set()}, {},
            [(("https://b", None, None), Forbidden("HTTP 403"))], {}, {}, "now")
        self.assertEqual((0, "empty"), rows[0][4:6])
        self.assertEqual((0, "forbidden"), rows[1][4:6])

    def test_fetch_streams_pages_instead_of_holding_every_row(self):
        fetch = notebook_cell_source("def staged_transcript_record")
        text = NOTEBOOK.read_text(encoding="utf-8")
        self.assertNotIn("rows.extend", fetch)
        self.assertNotIn("pd.DataFrame(_rows)", fetch)
        self.assertNotIn("import pandas", fetch)
        self.assertIn("on_page(page)", fetch)
        self.assertIn("spark.read.schema(_tx_schema).json(_tx_run_dir)", fetch)
        self.assertNotIn("PANDAS_TO_SPARK_CHUNK_ROWS", text)
        self.assertNotIn("RAW_TABLE_CHUNK_ROWS", text)
        self.assertNotIn("toPandas().fillna", text)
        parse = notebook_cell_source("def transcript_partition_parser")
        self.assertIn("mapPartitions(_parser)", parse)
        self.assertIn("StorageLevel.DISK_ONLY", parse)
        # The builders run inside Spark tasks now, so no cell calls them over every transcript.
        for needle in ("def build_sessions", "def build_turns", "def build_errors",
                       "def build_agent_dim", "def build_agent_performance"):
            calls = [node for node in ast.parse(notebook_cell_source(needle)).body
                     if isinstance(node, ast.Assign) and isinstance(node.value, ast.Call)
                     and getattr(node.value.func, "id", "").startswith("build_")]
            self.assertEqual([], calls, needle)


if __name__ == "__main__":
    unittest.main()
