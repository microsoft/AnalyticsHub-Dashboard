"""Agent linking and audit exclusion rules shared by the Fabric notebooks.

Spark is not available locally, so the pure-Python helpers are exec'd straight out of
the notebook cells and the exclusion CASE expression is run in sqlite.
"""
import ast
import json
import re
import sqlite3
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
NOTEBOOKS = ROOT / "fabric" / "notebooks"
INGESTER = NOTEBOOKS / "Copilot_Audit_Log_Direct_Ingester.ipynb"
PROCESSOR = NOTEBOOKS / "Copilot_Audit_Log_Processor.ipynb"

GUID_A = "11111111-2222-3333-4444-555555555555"
GUID_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
ZERO = "00000000-0000-0000-0000-000000000000"


def cells(path):
    return ["".join(cell["source"]) for cell in json.loads(path.read_text(encoding="utf-8"))["cells"]]


def load_pure(path, index, names):
    """Exec only the named top-level assignments and functions (no pyspark imports)."""
    tree = ast.parse(cells(path)[index])
    wanted = set(names)
    body = []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in wanted:
            body.append(node)
        elif isinstance(node, ast.Assign) and any(
                isinstance(t, ast.Name) and t.id in wanted for t in node.targets):
            body.append(node)
    ns = {"re": re}
    exec(compile(ast.Module(body=body, type_ignores=[]), f"{path.name}:cell{index}", "exec"), ns)
    missing = wanted - set(ns)
    if missing:
        raise AssertionError(f"{path.name} cell {index} lacks {sorted(missing)}")
    return ns


LINK_NAMES = [
    "PLATFORM_AGENT_ID_PATTERN", "BARE_GUID_PATTERN", "TITLE_SCHEMA_PATTERN", "EXCLUDE_REASON_SQL",
    "_link_key", "_letters", "_is_zero_guid", "_split_link_keys", "preferred_agent",
    "is_copilot_studio_copy", "build_agent_link_maps", "build_schema_title_map", "resolve_agent_link",
]

# (AppHost, Prompts_Available, AgentId, expected reason)
EXCLUDE_CASES = [
    ("Copilot Studio", "TRUE", "T_x.y", "Copilot Studio test pane"),
    (" copilot studio ", "FALSE", None, "Copilot Studio test pane"),
    ("pva-maker-evaluation", "FALSE", None, "Maker evaluation"),
    ("agentic-builder", "TRUE", None, "Agent authoring"),
    ("Autonomous", "FALSE", None, "Autonomous run"),
    ("workflow-agents", "FALSE", None, "Workflow run"),
    ("M365Copilot", "FALSE", None, "M365 Copilot twin"),
    ("m365copilot", "false", "T_abc", "M365 Copilot twin"),
    ("M365Copilot", "TRUE", None, None),
    ("M365Copilot", None, None, None),
    ("Teams", "FALSE", None, None),
    ("Teams", "TRUE", ZERO, "Fabric multi-agent"),
    ("Teams", "TRUE", "0000", "Fabric multi-agent"),
    ("Teams", "TRUE", GUID_A, None),
    ("Teams", "TRUE", "", None),
    (None, None, None, None),
    ("Outlook", "TRUE", "  ", None),
]


class ExcludeReasonTests(unittest.TestCase):
    def test_ingester_and_processor_share_identical_sql(self):
        ingester = load_pure(INGESTER, 18, ["EXCLUDE_REASON_SQL", "PLATFORM_AGENT_ID_PATTERN"])
        processor = load_pure(PROCESSOR, 2, ["EXCLUDE_REASON_SQL", "PLATFORM_AGENT_ID_PATTERN"])
        self.assertEqual(ingester["EXCLUDE_REASON_SQL"], processor["EXCLUDE_REASON_SQL"])
        self.assertEqual(ingester["PLATFORM_AGENT_ID_PATTERN"], processor["PLATFORM_AGENT_ID_PATTERN"])

    def test_case_expression_classifies_hosts(self):
        sql = load_pure(PROCESSOR, 2, ["EXCLUDE_REASON_SQL"])["EXCLUDE_REASON_SQL"]
        db = sqlite3.connect(":memory:")
        db.execute("CREATE TABLE t (AppHost TEXT, Prompts_Available TEXT, AgentId TEXT, expected TEXT)")
        db.executemany("INSERT INTO t VALUES (?,?,?,?)", EXCLUDE_CASES)
        got = db.execute(f"SELECT AppHost, Prompts_Available, AgentId, expected, {sql} FROM t").fetchall()
        for host, prompts, agent, expected, actual in got:
            with self.subTest(host=host, prompts=prompts, agent=agent):
                self.assertEqual(expected, actual)

    def test_processor_drops_every_reason_by_default_and_purges_merged_rows(self):
        code = cells(PROCESSOR)
        ns = {}
        exec(compile(code[1], "processor:cell1", "exec"), ns)
        sql = load_pure(PROCESSOR, 2, ["EXCLUDE_REASON_SQL"])["EXCLUDE_REASON_SQL"]
        reasons = set(re.findall(r"THEN '([^']+)'", sql))
        self.assertEqual(reasons, set(ns["DROP_EXCLUDE_REASONS"]))
        self.assertIn('F.expr(EXCLUDE_REASON_SQL)', code[4])
        self.assertIn("isin(*DROP_EXCLUDE_REASONS)", code[4])
        self.assertIn("isin(*DROP_EXCLUDE_REASONS)", code[15])
        self.assertIn('_sql.replace("Prompts_Available", "\'TRUE\'")', code[15])


class IngesterRuntimeRecordTests(unittest.TestCase):
    def test_copilot_studio_records_without_messages_are_kept(self):
        code = cells(INGESTER)
        self.assertIn("AgentPlatform", code[14])
        self.assertIn("PlatformAgentId", code[14])
        self.assertIn("ConversationId", code[14])
        self.assertIn("_copilot_studio_runtime", code[16])
        self.assertIn("'message:none'", code[16])
        self.assertIn("Prompts_Available", code[16])
        self.assertIn("F.expr(EXCLUDE_REASON_SQL)", code[18])
        self.assertIn("spark.databricks.delta.schema.autoMerge.enabled", code[20])

    def test_platform_agent_id_split(self):
        ns = load_pure(PROCESSOR, 2, ["PLATFORM_AGENT_ID_PATTERN", "BARE_GUID_PATTERN"])
        match = re.match(ns["PLATFORM_AGENT_ID_PATTERN"], f"Default-{GUID_B}_{GUID_A}")
        self.assertEqual((f"Default-{GUID_B}", GUID_A), match.groups())
        match = re.match(ns["PLATFORM_AGENT_ID_PATTERN"], f"{GUID_B}_{GUID_A.upper()}")
        self.assertEqual(GUID_A.upper(), match.group(2))
        self.assertIsNone(re.match(ns["PLATFORM_AGENT_ID_PATTERN"], GUID_A))
        self.assertIsNotNone(re.match(ns["BARE_GUID_PATTERN"], GUID_A))
        self.assertIsNone(re.match(ns["BARE_GUID_PATTERN"], f"T_{GUID_A}"))


def registry(*rows):
    keys = ("title", "bot", "entra", "type", "created_in", "updated")
    return [dict(zip(keys, row)) for row in rows]


class AgentLinkTests(unittest.TestCase):
    def setUp(self):
        self.ns = load_pure(PROCESSOR, 2, LINK_NAMES)
        self.build = self.ns["build_agent_link_maps"]
        self.resolve = self.ns["resolve_agent_link"]

    def test_keys_are_tried_in_order_and_names_are_never_used(self):
        maps = self.build(registry(
            ("T_title-1", "bot-1", "entra-1", "Shared", "Agent Builder", "2026-01-01"),
            ("T_title-2", "bot-2", "entra-2", "Shared", "Agent Builder", "2026-01-01"),
        ))
        self.assertEqual(("T_title-1", "T_title-1", "Title ID"),
                         self.resolve(maps, "t_TITLE-1", "bot-2", "entra-2"))
        self.assertEqual(("T_title-2", "T_title-2", "Bot Id"), self.resolve(maps, "T_missing", "BOT-2", "entra-1"))
        self.assertEqual(("T_title-1", "T_title-1", "Entra Agent ID"), self.resolve(maps, None, None, " ENTRA-1 "))
        self.assertEqual((None, None, "Unlinked"), self.resolve(maps, "T_missing", None, None))
        self.assertEqual((None, None, None), self.resolve(maps, None, "", None))
        self.assertNotIn("name", maps)
        self.assertNotIn("AgentName", cells(PROCESSOR)[11])
        self.assertNotIn("Agent name", cells(PROCESSOR)[11])

    def test_lob_and_shared_copilot_studio_copies_merge_to_the_lob_title(self):
        maps = self.build(registry(
            ("T_shared", "bot-x", None, "Shared", "Copilot Studio", "2026-05-01"),
            ("T_lob", "BOT-X", "entra-x", "LOB", "Copilot Studio", "2026-01-01"),
            ("T_shared2", None, "entra-x", "Shared", "Copilot Studio", "2026-06-01"),
        ))
        self.assertEqual(("T_lob", "T_shared", "Title ID"), self.resolve(maps, "T_shared", None, None))
        self.assertEqual(("T_lob", "T_shared2", "Title ID"), self.resolve(maps, "T_shared2", None, None))
        self.assertEqual(("T_lob", "T_lob", "Bot Id"), self.resolve(maps, None, "bot-x", None))
        self.assertEqual(("T_lob", "T_lob", "Entra Agent ID"), self.resolve(maps, None, None, "entra-x"))

    def test_shared_copies_without_lob_merge_to_newest(self):
        maps = self.build(registry(
            ("T_old", "bot-y", None, "Shared", "Copilot Studio", "2026-01-01"),
            ("T_new", "bot-y", None, "Shared", "Copilot Studio", "2026-03-01"),
        ))
        self.assertEqual("T_new", self.resolve(maps, "T_old", None, None)[0])

    def test_agent_builder_and_unrelated_agents_are_not_merged(self):
        maps = self.build(registry(
            ("T_ab1", None, "entra-z", "Shared", "Agent Builder", "2026-01-01"),
            ("T_ab2", None, "entra-z", "LOB", "Agent Builder", "2026-02-01"),
            ("T_ms", "bot-m", None, "Microsoft", "Copilot Studio", "2026-02-01"),
            ("T_cs", "bot-m", None, "Shared", "Copilot Studio", "2026-02-01"),
        ))
        self.assertEqual(("T_ab1", "T_ab1", "Title ID"), self.resolve(maps, "T_ab1", None, None))
        self.assertEqual(("T_ab2", "T_ab2", "Title ID"), self.resolve(maps, "T_ab2", None, None))
        self.assertEqual(("T_ms", "T_ms", "Title ID"), self.resolve(maps, "T_ms", None, None))
        self.assertEqual({}, maps["canonical"])
        # An Entra id shared by unmerged agents still resolves, preferring the LOB copy.
        self.assertEqual("T_ab2", self.resolve(maps, None, None, "entra-z")[0])

    def test_all_zero_entra_ids_are_ignored(self):
        maps = self.build(registry(
            ("T_1", None, ZERO, "LOB", "Copilot Studio", "2026-01-01"),
            ("T_2", None, ZERO, "LOB", "Copilot Studio", "2026-01-01"),
        ))
        self.assertEqual({}, maps["entra"])
        self.assertEqual({}, maps["canonical"])
        self.assertEqual((None, None, None), self.resolve(maps, None, None, ZERO))

    def test_multiple_bot_ids_and_duplicate_registry_rows(self):
        maps = self.build(registry(
            ("T_a", "bot-1; bot-2", None, "LOB", "Copilot Studio", "2026-01-01"),
            ("T_a", "bot-1; bot-2", None, "LOB", "Copilot Studio", "2026-01-01"),
            (" ", "bot-3", None, "LOB", "Copilot Studio", "2026-01-01"),
        ))
        self.assertEqual({"T_A": "T_a"}, maps["title"])
        self.assertEqual("T_a", self.resolve(maps, None, "bot-2", None)[0])
        self.assertEqual({}, maps["canonical"])

    def test_schema_guid_map_requires_one_title(self):
        title_a, title_b = f"T_{GUID_A}", f"T_{GUID_B}"
        schema_1, schema_2 = "12345678-1234-1234-1234-123456789012", "87654321-4321-4321-4321-210987654321"
        schema = self.ns["build_schema_title_map"]([
            f"{title_a}.{schema_1}", f"{title_a}.{schema_1}", f"{title_a}.{schema_2}",
            f"{title_b}.{schema_2}", "not-an-agent", None,
        ])
        self.assertEqual({schema_1: title_a.upper()}, schema)
        maps = self.build(registry((title_a, None, None, "LOB", "Agent Builder", "2026-01-01")))
        self.assertEqual((title_a, title_a, "Schema GUID"),
                         self.resolve(maps, schema_1.upper(), None, schema_1, schema[schema_1]))

    def test_processor_link_cell_joins_on_all_three_keys(self):
        code = cells(PROCESSOR)
        self.assertIn("build_agent_link_maps(_registry_rows)", code[11])
        for key in ("__lk_title", "__lk_bot", "__lk_entra"):
            self.assertIn(f'fact["{key}"].eqNullSafe', code[11])
        for column in ("Agent_MatchedTitleID", "Agent_LinkMethod", "Agent_BotId", "Exclude_Reason"):
            self.assertIn(f'"{column}"', code[12])


if __name__ == "__main__":
    unittest.main()
