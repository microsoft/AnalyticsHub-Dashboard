"""Deterministic simulated configuration and security evidence; never a tenant export."""
from datetime import date, timedelta
import csv
import hashlib
from pathlib import Path

SEED = "analytics-governance-v1"


def build(people, agents, activity):
    def pick(key, size):
        return int(hashlib.sha256(f"{SEED}:{key}".encode()).hexdigest()[:12], 16) % size

    users = {person["user"]: person for person in people}
    config = []
    for index, agent in enumerate(agents):
        name = agent["Agent name"]
        rows = [row for row in activity if row["agent"] == name]
        owner_id = agent.get("Agent creator UPN", "").lower()
        owner = users.get(owner_id)
        config.append({
            "id": agent["Title ID"], "agent": name, "type": agent["Agent type (A365)"],
            "resource": f"synthetic-agent-{index:04d}", "snapshot": "2026-08-31",
            "owner": owner_id if owner else "",
            "ownerStatus": "Active" if owner and owner["active"] else "Disabled" if owner else "Not checked",
            "noSignIn": index % 5 == 0, "webSearch": index % 3 == 0,
            "quarantined": agent.get("Is Blocked", "").lower() in ("yes", "true", "1"),
            "scope": "Whole organisation" if agent["Availability"] == "Everyone" else
                     "Specific people or groups" if "specific" in agent["Availability"].lower() else "Not shared",
            "access": "Organisation content" if any(agent.get(field, "").lower() == "yes" for field in
                       ("Can read OneDrive and Sharepoint items", "Can extend to Graph connector")) else
                      "Uploaded files only" if agent.get("Contains uploaded files", "").lower() == "yes" else "None declared",
            "users": len({row["user"] for row in rows}),
            "tenant": bool(agent.get("Created in")) and agent["Created in"].lower() != "not available",
        })
    with (Path(__file__).resolve().parents[3] / "samples" / "consumption" / "AzureSolutionSpend.csv").open(
            encoding="utf-8-sig", newline="") as stream:
        accounts = {row["ResourceId"].lower(): row for row in csv.DictReader(stream)
                    if "/providers/microsoft.cognitiveservices/" in row["ResourceId"].lower()
                    or "/providers/microsoft.machinelearningservices/" in row["ResourceId"].lower()}
    foundry = []
    for index, (resource_id, account) in enumerate(sorted(accounts.items())):
        foundry.append({"id": resource_id, "account": resource_id, "name": account["ResourceName"],
                        "group": account["ResourceGroup"], "subscription": account["SubscriptionId"],
                        "snapshot": "2026-08-31", "public": index % 2 == 0, "project": False})
        foundry.append({"id": f"{resource_id}/projects/synthetic-project-{index}", "account": resource_id,
                        "name": f"Synthetic project {index + 1}", "group": account["ResourceGroup"],
                        "subscription": account["SubscriptionId"], "snapshot": "2026-08-31",
                        "public": index % 2 == 0, "project": True})
    watchlist = [
        {"tool": "Unreviewed writing assistant", "posture": "Not reviewed"},
        {"tool": "Unapproved coding assistant", "posture": "Unsanctioned"},
        {"tool": "Unreviewed meeting assistant", "posture": "Not reviewed"},
        {"tool": "Approved productivity assistant", "posture": "Sanctioned"},
    ]
    events = []
    billing = []
    for offset in range(92):
        day = date(2026, 6, 1) + timedelta(days=offset)
        for product in ("Copilot Studio", "Cowork", "Other Copilot service"):
            credits = 80 + pick(f"billing:{product}:{offset}", 170)
            billing.append({"date": day.isoformat(), "product": product, "credits": credits,
                            "cost": round(credits * 0.0092, 4), "currency": "USD",
                            "subscription": "synthetic-billing-subscription"})
        if day.weekday() > 4:
            continue
        for index, person in enumerate(people):
            if not person["active"] or pick(f"{offset}:{index}", 9) > 1:
                continue
            tool = watchlist[pick(f"tool:{index}", len(watchlist))]["tool"]
            layer = ("Ran", "Network", "Installed", "Cloud Discovery")[pick(f"layer:{offset}:{index}", 4)]
            events.append({"id": f"simulated-{offset:02d}-{index:03d}", "date": day.isoformat(),
                           "user": person["user"], "device": f"synthetic-device-{index:03d}",
                           "tool": tool, "layer": layer})
    return {"seed": SEED, "description": "Generated synthetic configuration and findings, not tenant observations.",
            "config": config, "foundry": foundry, "watchlist": watchlist, "events": events,
            "billing": billing}
