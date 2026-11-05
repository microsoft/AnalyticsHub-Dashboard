"""Focused, offline source invariants. Run: python -m unittest discover -s scripts\\demo_sources -p test_evaluator.py."""

import csv
import json
from pathlib import Path
import unittest

from evaluator import build, END, START


ROOT = Path(__file__).resolve().parents[3]


def published_inventory():
    with (ROOT / "samples" / "copilot_users_sample.csv").open(encoding="utf-8-sig", newline="") as stream:
        people = [{
            "user": row["PersonId"].lower(), "name": row["displayName"], "org": row["Organization"],
            "job": row["JobTitle"], "country": row["country"],
            "licensed": row["Has license"].lower() in ("yes", "true", "1"),
            "active": row["accountEnabled"].lower() in ("yes", "true", "1"),
        } for row in csv.DictReader(stream)]
    with (ROOT / "samples" / "agents_365_sample.csv").open(encoding="utf-8-sig", newline="") as stream:
        agents = list(csv.DictReader(stream))
    return people, agents


class EvaluatorSourceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.people, cls.agents = published_inventory()
        cls.payload = build(cls.people, cls.agents, [])

    def test_deterministic_serializable_and_inventory_bound(self):
        self.assertEqual(len(self.people), 170)
        again = build(list(reversed(self.people)), list(reversed(self.agents)), [])
        self.assertEqual(self.payload, again)
        self.assertEqual(json.loads(json.dumps(self.payload)), self.payload)
        identities = {person["user"] for person in self.people if person["active"]}
        self.assertTrue({row["user"] for row in self.payload["sessions"]} <= identities)
        self.assertEqual({row["user"] for row in self.payload["people"]}, {row["user"] for row in self.people})
        eligible = {row["Agent name"] for row in self.agents
                    if row["Created in"] == "Copilot Studio" and row["Sensitivity"] in ("General", "Public")
                    and row["Availability"].lower() != "private" and row["Is Blocked"] != "true"}
        self.assertEqual({row["agent"] for row in self.payload["catalog"]}, eligible)
        self.assertTrue({row["agent"] for row in self.payload["sessions"]} <= eligible)
        self.assertTrue(self.payload["provenance"]["synthetic"])

    def test_complete_source_evidence_and_date_coverage(self):
        data = self.payload
        sessions = {row["id"]: row for row in data["sessions"]}
        turns = {row["id"]: row for row in data["turns"]}
        sources = {source["id"] for agent in data["catalog"] for source in agent["sources"]}
        self.assertGreater(len(sessions), 1500)
        self.assertEqual(min(row["date"] for row in sessions.values()), START.isoformat())
        self.assertEqual(max(row["date"] for row in sessions.values()), END.isoformat())
        self.assertEqual(len({row["date"] for row in sessions.values()}), 92)
        self.assertEqual(len({row["outcome"] for row in sessions.values()}), 4)
        self.assertEqual(len({row["archetype"] for row in sessions.values()}), 4)
        self.assertEqual(len({row["theme"] for row in sessions.values()}), 6)
        self.assertEqual(len(sessions), len({row["session"] for row in turns.values()}))
        for row in data["turns"]:
            self.assertIn(row["session"], sessions)
            self.assertGreater(row["responseSeconds"], 0)
            if row["feedbackComment"]:
                self.assertTrue(row["feedbackComment"].startswith("Synthetic feedback:"))
                self.assertIn(row["feedbackVerdict"], ("Positive", "Negative"))
        for row in data["errors"] + data["citations"]:
            self.assertIn(row["session"], sessions)
            self.assertEqual(turns[row["turn"]]["session"], row["session"])
        for row in data["citations"]:
            self.assertIn(row["source"], sources)
            self.assertTrue(sessions[row["session"]]["knowledgeAnswered"])
        with_errors = {row["session"] for row in data["errors"]}
        self.assertTrue({row["id"] for row in sessions.values() if row["outcome"] == "Escalated - Unintended"} <= with_errors)
        self.assertEqual({row["source"] for row in data["errors"]}, {"User fault", "System fault"})
        self.assertGreater(sum(bool(row["feedbackComment"]) for row in data["turns"]), 100)

    def test_activity_is_only_a_deterministic_daily_volume_weight(self):
        person = next(row for row in self.people if row["active"])
        activity = [{"user": person["user"], "date": "2026-06-01", "observed": True,
                     "message": "DO NOT COPY THIS CONTENT"}] * 8
        weighted = build(self.people, self.agents, activity)
        self.assertNotIn("DO NOT COPY THIS CONTENT", json.dumps(weighted))
        self.assertEqual(weighted, build(self.people, self.agents, list(reversed(activity))))
        self.assertEqual(
            [row for row in self.payload["sessions"] if row["user"] != person["user"]],
            [row for row in weighted["sessions"] if row["user"] != person["user"]],
        )

    def test_restricted_agents_are_not_used_and_missing_eligible_catalog_is_explicit(self):
        people = [self.people[0]]
        restricted = [{"Agent name": "Restricted sentinel", "Created in": "Copilot Studio",
                       "Sensitivity": "Confidential", "Availability": "Private", "Is Blocked": "false"}]
        with self.assertRaisesRegex(ValueError, "General/Public"):
            build(people, restricted, [])
        result = build(people, self.agents + restricted, [])
        self.assertNotIn("Restricted sentinel", json.dumps(result))
        with self.assertRaisesRegex(ValueError, "unique"):
            build(people * 2, self.agents, [])


if __name__ == "__main__":
    unittest.main()
