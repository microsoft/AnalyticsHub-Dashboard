"""Deterministic, fictional M365 person-day reports for the DataHub App demo.

Only the published sample identity keys are reused. No telemetry is copied.
SHA-256 keyed draws are independent of input ordering, Python RNG and locale.
"""

from datetime import date, timedelta
from hashlib import sha256


START = date(2026, 6, 1)
END = date(2026, 8, 31)
APPS = ("Outlook", "Teams", "Word", "Excel", "PowerPoint", "OneNote")
WORKLOADS = ("Teams", "Email", "SharePoint", "OneDrive", "Apps", "VivaEngage")


def _draw(user, key, limit):
    return int.from_bytes(sha256(f"m365-demo-v1|{user}|{key}".encode()).digest()[:8], "big") % limit


def build(people, agents, activity):
    """Return JSON-serializable source records, not precomputed visual results."""
    del agents, activity  # Other sources must not become fictional M365 events.
    rows = []
    for person in sorted(people, key=lambda item: item["user"]):
        user = person["user"]
        breadth = _draw(user, "suite-breadth", 7)
        preferred = sorted(APPS, key=lambda app: (_draw(user, f"app-{app}", 10000), app))[:breadth]
        desktop = "Mac" if _draw(user, "desktop", 5) == 0 else "Windows"
        # Stable job-family differences, with individual variation within each org.
        collaborative = person["org"] in ("Sales", "Customer Service", "Executive Office", "Marketing")
        for offset in range((END - START).days + 1):
            day = START + timedelta(days=offset)
            key = day.isoformat()
            draw = lambda label, limit: _draw(user, f"{key}|{label}", limit)
            # Weekday absences and sparse weekend work are intentional. Zero rows
            # retain the loaded report-day denominator used by the DAX contracts.
            working = draw("attendance", 100) < (18 if day.weekday() >= 5 else 78 + _draw(user, "attendance", 20))
            intensity = 1 + draw("intensity", 4) + (day.month - 6)
            apps = {f"App{app}": int(working and app in preferred and draw(f"open-{app}", 100) < 70) for app in APPS}
            flags = {
                "Teams": int(working and draw("teams", 100) < (95 if collaborative else 80)),
                "Email": int(working and draw("email", 100) < 91),
                "SharePoint": int(working and draw("sharepoint", 100) < 63 + (day.month - 6) * 7),
                "OneDrive": int(working and draw("onedrive", 100) < 57),
                "Apps": int(any(apps.values())),
                "VivaEngage": int(working and draw("viva", 100) < 15 + _draw(user, "community", 20)),
            }
            meetings = flags["Teams"] * draw("meetings", 4 + int(collaborative) * 3)
            platforms = {
                f"Platform{platform}": int(flags["Apps"] and (
                    platform == desktop
                    or platform == "Web" and draw("web", 100) < 56
                    or platform == "Mobile" and draw("mobile", 100) < (65 if collaborative else 32)
                ))
                for platform in ("Windows", "Mac", "Web", "Mobile")
            }
            rows.append({
                "UPN_Normalized": user,
                "ActivityDate": key,
                "WeekStart": (day - timedelta(days=day.weekday())).isoformat(),
                **{f"{name}Active": flags[name] for name in WORKLOADS},
                "WorkloadsActive": sum(flags.values()),
                "TeamsMeetings": meetings,
                "TeamsAudioSeconds": meetings * (900 + 300 * draw("duration", 7)),
                "EmailSent": flags["Email"] * (2 + intensity * (1 + draw("email-volume", 6))),
                "TeamsChatMessages": flags["Teams"] * intensity * draw("channel-volume", 8),
                "TeamsPrivateChatMessages": flags["Teams"] * intensity * (1 + draw("chat-volume", 11)),
                "SharePointFilesViewedOrEdited": flags["SharePoint"] * (1 + draw("shared-files", 13)),
                "OneDriveFilesViewedOrEdited": flags["OneDrive"] * (1 + draw("personal-files", 9)),
                **apps,
                **platforms,
            })
    return {
        "activity": rows,
        "provenance": {
            "description": "Fictional deterministic M365 reports; published sample identities only; no tenant telemetry.",
            "classification": "Public synthetic demo data",
            "generator": "m365-demo-v1",
            "seed": "m365-demo-v1",
            "firstDate": START.isoformat(),
            "lastDate": END.isoformat(),
            "people": len(people),
            "rules": [
                "SHA-256 keyed person/day draws; Monday week starts; original June-August 2026 dates.",
                "Weekday attendance 78-97%; weekend attendance 18%; zero-activity report rows retained.",
                "Stable person suite breadth 0-6, desktop preference and collaborative job-family profile.",
                "Apps and platform flags imply Office activity; workload counts sum six activity flags.",
                "Volumes depend on active workloads, person/day variation and gradual monthly intensity.",
            ],
        },
    }
