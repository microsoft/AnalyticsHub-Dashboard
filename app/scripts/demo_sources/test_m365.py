"""Focused offline checks for the fictional M365 source generator."""

import importlib.util
import json
from pathlib import Path
import unittest


HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("m365", HERE / "m365.py")
m365 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m365)


class M365SourceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        source = json.loads((HERE.parents[1] / "src" / "demo" / "sample-data.generated.json").read_text(encoding="utf-8"))
        cls.people = source["people"]
        cls.payload = m365.build(cls.people, source["agents"], source["activity"])
        cls.rows = cls.payload["activity"]

    def test_existing_identities_original_dates_and_unique_person_days(self):
        self.assertEqual(len(self.people), 170)
        self.assertEqual({row["UPN_Normalized"] for row in self.rows}, {person["user"] for person in self.people})
        self.assertEqual(len(self.rows), 170 * 92)
        self.assertEqual(len({(row["UPN_Normalized"], row["ActivityDate"]) for row in self.rows}), len(self.rows))
        self.assertEqual(min(row["ActivityDate"] for row in self.rows), "2026-06-01")
        self.assertEqual(max(row["ActivityDate"] for row in self.rows), "2026-08-31")
        self.assertEqual(len({row["ActivityDate"] for row in self.rows}), 92)
        self.assertTrue(all(row["WeekStart"] <= row["ActivityDate"] for row in self.rows))

    def test_deterministic_order_independent_and_no_telemetry_replay(self):
        other = m365.build(list(reversed(self.people)), [{"ignored": "agent"}], [{"ignored": "activity"}])
        self.assertEqual(self.payload, other)
        self.assertEqual(json.loads(json.dumps(self.payload)), self.payload)
        self.assertIn("synthetic", self.payload["provenance"]["classification"])
        self.assertEqual(self.payload["provenance"]["seed"], "m365-demo-v1")
        self.assertEqual(self.payload["provenance"]["seed"], self.payload["provenance"]["generator"])

    def test_workload_app_platform_and_volume_reconciliation(self):
        for row in self.rows:
            flags = [row[f"{name}Active"] for name in m365.WORKLOADS]
            self.assertTrue(all(flag in (0, 1) for flag in flags))
            self.assertEqual(row["WorkloadsActive"], sum(flags))
            self.assertEqual(row["AppsActive"], int(any(row[f"App{app}"] for app in m365.APPS)))
            if not row["AppsActive"]:
                self.assertEqual(sum(row[f"Platform{platform}"] for platform in ("Windows", "Mac", "Web", "Mobile")), 0)
            for flag, metrics in (
                ("TeamsActive", ("TeamsMeetings", "TeamsAudioSeconds", "TeamsChatMessages", "TeamsPrivateChatMessages")),
                ("EmailActive", ("EmailSent",)),
                ("SharePointActive", ("SharePointFilesViewedOrEdited",)),
                ("OneDriveActive", ("OneDriveFilesViewedOrEdited",)),
            ):
                if not row[flag]:
                    self.assertTrue(all(row[metric] == 0 for metric in metrics))
            self.assertTrue(all(value >= 0 for value in row.values() if isinstance(value, int)))

    def test_varied_daily_work_and_all_suite_depth_profiles(self):
        self.assertGreater(len({row["TeamsMeetings"] for row in self.rows}), 4)
        self.assertGreater(len({row["EmailSent"] for row in self.rows}), 15)
        self.assertEqual({row["WorkloadsActive"] for row in self.rows}, set(range(7)))
        depths = {
            sum(any(row[f"App{app}"] for row in self.rows if row["UPN_Normalized"] == person["user"]) for app in m365.APPS)
            for person in self.people
        }
        self.assertEqual(depths, set(range(7)))
        for platform in ("Windows", "Mac", "Web", "Mobile"):
            self.assertTrue(any(row[f"Platform{platform}"] for row in self.rows))


if __name__ == "__main__":
    unittest.main()
