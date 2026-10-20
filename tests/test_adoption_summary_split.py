"""The Adoption summary's two queries, checked against the templates.

The app asks for the Adoption summary in two queries: adoption-summary.dax has
ten figures, and adoption-summary-spuw.dax has the five sessions-per-user-per-week
figures. The app's adoption-summary-split.spec.ts proves they are the whole
query's fifteen columns shared out, under the same filters. It also proves the
app defines the task-time measures in the first part exactly as it did in the
whole query, and defines none in the second.

This file checks the model side. Every measure the two parts ask for is in both
Fabric templates, and none of the five figures reaches a task-time measure
through the model. A model measure keeps reading the model's measures whatever
the query defines, so the five never saw the task times in the whole query
either. This test keeps the split safe even if that stops being true.
"""
import importlib.util
import json
import re
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("template_dax", ROOT / "scripts" / "Update-Template-Dax.py")
PATCHER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PATCHER)
QUERIES = ROOT / "app" / "src" / "queries"
CORE = QUERIES / "adoption" / "adoption-summary.dax"
SPUW = QUERIES / "adoption" / "adoption-summary-spuw.dax"
HOURS = QUERIES / "assumptions" / "hours-measures.ts"

# Strings, quoted names and [names] are kept whole, so a comment marker inside one isn't one.
TOKEN = re.compile(r"\"(?:[^\"]|\"\")*\"|'(?:[^']|'')*'|\[[^\]]*\]|/\*.*?\*/|(?://|--)[^\n]*", re.S)


def references(expression):
    """The [names] an expression uses, outside strings and comments."""
    expression = "\n".join(expression) if isinstance(expression, list) else (expression or "")
    return {m.group(0)[1:-1] for m in TOKEN.finditer(expression) if m.group(0)[0] == "["}


def measures(relative):
    with zipfile.ZipFile(ROOT / relative) as archive:
        model = json.loads(archive.read("DataModelSchema").decode("utf-16-le"))["model"]
    return {m["name"]: m["expression"] for t in model["tables"] for m in t.get("measures", [])}


def reached(expressions, start):
    """Every measure the names in `start` reach through the model, themselves included."""
    names = set(expressions)
    seen, todo = set(), [name for name in start if name in names]
    while todo:
        name = todo.pop()
        if name not in seen:
            seen.add(name)
            todo.extend(references(expressions[name]) & names)
    return seen


class AdoptionSummarySplit(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.core = references(CORE.read_text(encoding="utf-8"))
        cls.spuw = references(SPUW.read_text(encoding="utf-8"))
        # HOURS_MEASURES: the only measures withTaskTimes defines. The first reads the minutes.
        cls.hours = re.findall(r'^\s*name: "([^"]+)",', HOURS.read_text(encoding="utf-8"), re.M)

    def test_the_parts_ask_for_fifteen_measures_between_them(self):
        self.assertEqual(len(self.core), 10)
        self.assertEqual(len(self.spuw), 5)
        self.assertEqual(self.core & self.spuw, set())

    def test_every_measure_they_ask_for_is_in_both_templates(self):
        self.assertEqual(len(PATCHER.VALUELENS), 2)
        for relative in PATCHER.VALUELENS:
            with self.subTest(template=str(relative)):
                self.assertEqual((self.core | self.spuw) - set(measures(relative)), set())

    def test_the_task_times_reach_only_the_first_part(self):
        minutes = self.hours[0]
        self.assertEqual(minutes, "Human Equivalent Hours (Behaviour Basis)")
        for relative in PATCHER.VALUELENS:
            expressions = measures(relative)
            with self.subTest(template=str(relative)):
                self.assertEqual(
                    reached(expressions, self.spuw) & set(self.hours),
                    set(),
                    "a sessions-per-user-per-week figure reads a task-time measure: ask for it with the other ten",
                )
                # The ten reach the minutes only through the model, so this shows the walk follows it.
                self.assertNotIn(minutes, self.core)
                self.assertIn(minutes, reached(expressions, self.core))


if __name__ == "__main__":
    unittest.main()
