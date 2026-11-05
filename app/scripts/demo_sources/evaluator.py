"""Deterministic, invented Evaluator evidence for the offline Analytics demo.

Only identity keys and eligible synthetic registry names come from the caller.
No transcripts, chart fixtures, endpoints, or model data are read here. Activity
contributes daily volume weights, never conversation content. The adapter derives
every visual from the returned evidence rather than precomputed chart rows.
"""

from collections import Counter
from datetime import date, timedelta
import hashlib
import random


START = date(2026, 6, 1)
END = date(2026, 8, 31)
SEED = "analytics-evaluator-synthetic-v1"
TOPICS = (
    ("Getting started", "WorkspaceOrientation", "AccountChecklist"),
    ("Everyday requests", "RequestPreparation", "RequestProgress"),
    ("Guidance", "ProcessGuidance", "EligibilityGuidance"),
    ("Planning", "PlanningChecklist", "SchedulePreparation"),
    ("Troubleshooting", "ConnectionDiagnosis", "AccessRecovery"),
    ("Review", "SubmissionReview", "NextStepReview"),
)
OUTCOMES = ("Resolved", "Escalated - Intended", "Escalated - Unintended", "Abandoned")


def _random(*keys):
    digest = hashlib.sha256("|".join((SEED, *map(str, keys))).encode()).digest()
    return random.Random(int.from_bytes(digest[:8], "big"))


def build(people, agents, activity):
    """Return JSON-serializable source facts; never writes files or uses a network."""
    inventory = sorted(
        ({key: person[key] for key in ("user", "org", "job", "country", "licensed", "active")}
         for person in people),
        key=lambda person: person["user"],
    )
    if len({person["user"] for person in inventory}) != len(inventory):
        raise ValueError("Evaluator requires unique normalized inventory identities")
    # Never carry restricted metadata or names into this synthetic source.
    names = sorted({
        agent["Agent name"] for agent in agents
        if agent.get("Created in") == "Copilot Studio"
        and agent.get("Sensitivity", "").lower() in ("general", "public")
        and agent.get("Availability", "").lower() != "private"
        and agent.get("Is Blocked", "").lower() not in ("true", "1", "yes")
        and agent.get("Agent name")
    })
    if not names:
        raise ValueError("Evaluator needs an unblocked General/Public synthetic Studio agent")
    catalog = []
    for index, name in enumerate(names):
        theme, first, second = TOPICS[index % len(TOPICS)]
        catalog.append({
            "agent": name, "theme": theme, "topics": [first, second],
            "deflectionMinutes": 8,
            "sources": [
                {"id": f"synthetic-source-{index + 1}-{part + 1}",
                 "label": f"Synthetic {theme.lower()} {'handbook' if part == 0 else 'checklist'}",
                 "uri": f"https://evaluator-demo.invalid/knowledge/{index + 1}/{part + 1}"}
                for part in range(2)
            ],
        })
    weights = Counter(
        (row.get("user", "").lower(), row.get("date", ""))
        for row in activity if row.get("observed")
    )
    sessions, turns, errors, citations = [], [], [], []
    for day_index in range((END - START).days + 1):
        day = (START + timedelta(days=day_index)).isoformat()
        for person in inventory:
            if not person["active"]:
                continue
            rng = _random(person["user"], day)
            # Source activity only changes likelihood. Dates are never shifted.
            likelihood = 0.17 + min(weights[(person["user"], day)], 6) * 0.025
            if rng.random() >= likelihood:
                continue
            entry = catalog[rng.randrange(len(catalog))]
            agent_index = names.index(entry["agent"])
            topic_index = rng.randrange(2)
            # Vary quality by topic, agent, and month, so comparisons have evidence.
            resolution = 0.62 + day_index / 920 - (agent_index % 4) * 0.035 - topic_index * 0.04
            roll = rng.random()
            outcome = OUTCOMES[0 if roll < resolution else 1 if roll < resolution + 0.15
                               else 2 if roll < resolution + 0.26 else 3]
            failing = outcome in OUTCOMES[2:]
            searched = rng.random() < 0.82
            answered = searched and rng.random() < (0.50 if failing else 0.93)
            error_count = int(outcome == OUTCOMES[2] or rng.random() < (0.24 if failing else 0.035))
            count = rng.randint(2, 6) if failing else rng.choices((1, 2, 3, 4), (5, 4, 2, 1))[0]
            session_id = f"synthetic-eval-{day_index:02d}-{person['user']}"
            archetype = ("Error" if outcome == OUTCOMES[2] else "Human hand-off"
                         if outcome == OUTCOMES[1] else "Knowledge grounded" if answered
                         else "Model generated")
            sessions.append({
                "id": session_id, "user": person["user"], "date": day,
                "agent": entry["agent"], "theme": entry["theme"],
                "topic": entry["topics"][topic_index], "outcome": outcome,
                "impliedSuccess": outcome == OUTCOMES[0] and rng.random() < 0.88,
                "knowledgeSearched": searched, "knowledgeAnswered": answered,
                "grounding": "Internal" if answered else "None", "archetype": archetype,
            })
            for turn_index in range(count):
                turn_id = f"{session_id}-turn-{turn_index + 1}"
                response = round(rng.uniform(1.0, 7.5) + (8 if rng.random() < 0.13 else 0), 2)
                verdict, comment = "", ""
                if turn_index == count - 1 and rng.random() < 0.38:
                    verdict = "Positive" if rng.random() < (0.30 if failing else 0.91) else "Negative"
                    if rng.random() < 0.68:
                        choices = (
                            ("Synthetic feedback: the checklist clarified my next step.",
                             "Synthetic feedback: a useful reference for this request.")
                            if verdict == "Positive" else
                            ("Synthetic feedback: the guidance needs another example.",
                             "Synthetic feedback: I still needed help completing the request.")
                        )
                        comment = rng.choice(choices)
                turns.append({
                    "id": turn_id, "session": session_id, "responseSeconds": response,
                    "feedbackVerdict": verdict, "feedbackComment": comment,
                })
                if answered and (turn_index == 0 or rng.random() < 0.25):
                    source = rng.choice(entry["sources"])
                    citations.append({"session": session_id, "turn": turn_id, "source": source["id"]})
                if error_count and turn_index == count - 1:
                    user_fault = rng.random() < 0.22 and outcome != OUTCOMES[2]
                    errors.append({
                        "session": session_id, "turn": turn_id,
                        "code": rng.choice(("MissingRequestField", "InvalidRequestFormat") if user_fault
                                           else ("SyntheticConnectorTimeout", "SyntheticLookupUnavailable", "SyntheticActionFailure")),
                        "source": "User fault" if user_fault else "System fault",
                    })
    sessions.sort(key=lambda row: (row["date"], row["id"]))
    return {
        "provenance": {
            "synthetic": True, "seed": SEED,
            "description": "Invented offline Evaluator sessions, turns, errors, citations and feedback; not tenant transcripts.",
            "start": START.isoformat(), "end": END.isoformat(),
            "volumeBasis": "Inventory identities and daily synthetic observed-activity counts only.",
        },
        "people": inventory, "catalog": catalog, "sessions": sessions,
        "turns": turns, "errors": errors, "citations": citations,
        "status": {
            "environment": "Synthetic offline Evaluator", "lookbackDays": (END - START).days + 1,
        },
    }
