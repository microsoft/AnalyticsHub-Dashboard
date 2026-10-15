"""Generate the INPUT tables in the golden test data for the audit-log processor parity harness.

    python "tests/fixtures/valuelens-golden/make_fixtures.py"

The output is deterministic: running it again produces byte-identical files. Every identity is
synthetic (example.invalid). The EXPECTED outputs are produced separately, by running the real
Fabric notebook in local Spark:  python tests/valuelens_golden.py --regenerate
"""
import json
from datetime import datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
INPUTS = HERE / "inputs"

# Columns that Copilot_Audit_Log_Direct_Ingester writes to copilot_interactions_parsed, in order.
MODERN_COLUMNS = [
    ("Id", "string"), ("RecordId", "string"), ("Source_RecordKey", "string"),
    ("Source_MessageKey", "string"), ("Source_ResourceKey", "string"),
    ("CreationDate", "timestamp"), ("AgentId", "string"), ("AgentName", "string"),
    ("AppIdentity_AppId", "string"), ("AppIdentity_DisplayName", "string"),
    ("AppIdentity_PublisherId", "string"), ("ApplicationName", "string"), ("ClientRegion", "string"),
    ("Audit_UserId", "string"), ("Audit_UserId_Normalized", "string"), ("Workload", "string"),
    ("AppHost", "string"), ("ThreadId", "string"), ("SensitivityLabelId", "string"),
    ("Context_Type", "string"), ("AISystemPlugin_Id", "string"), ("AISystemPlugin_Name", "string"),
    ("ModelTransparencyDetails_ModelName", "string"),
    ("AccessedResource_Type", "string"), ("AccessedResource_Action", "string"),
    ("AccessedResource_SiteUrl", "string"), ("AccessedResource_SensitivityLabelId", "string"),
    ("Message_Id", "string"), ("Message_isPrompt", "string"),
    ("Message_Ordinal", "bigint"), ("Resource_Ordinal", "bigint"), ("Resource_Count", "bigint"),
    ("InteractionDate", "date"), ("WeekStart", "date"), ("MonthStart", "date"),
    ("Agent_TitleID", "string"), ("Agent_EntraId", "string"),
]

GUID_A = "0f8fad5b-d9cb-469f-a165-70867728950e"
GUID_B = "7c9e6679-7425-40de-944b-e07fc1f90ae7"

# One scenario per behaviour branch: (AppHost, Context_Type, ResType, ResAction, SiteUrl,
# PluginId, PluginName, Model, AgentName, AgentId, SensitivityLabel, ResSensitivityLabel)
S = [
    ("Outlook", None, "EmailMessage", "Read", None, None, None, "DEEP_LEO", None, None, None, None),
    ("Outlook", None, "EmailMessage", "Draft", None, None, None, "gpt-4.1-mini", None, None, None, None),
    ("Outlook", None, None, "SendEmailV2", None, None, None, "GPT-5-chat", None, None, None, None),
    ("OutlookSidePane", None, None, None, None, None, None, None, None, None, None, None),
    ("Teams", "TeamsMeeting", "Event", "Read", None, None, None, "o3-mini", None, None, None, None),
    ("Teams", None, None, "mcp_MeetingManagement", None, None, None, "REASONING_V2", None, None, None, None),
    ("Teams", "TeamsChat", "TeamsMessage", "PostMessageToConversation", None, None, None, "o1-preview", None, None, None, None),
    ("Teams", None, "TeamsChannel", "Read", None, None, None, None, None, None, "lbl-1", None),
    ("Excel", "xlsx", "xlsx", "Write", None, None, None, "claude-sonnet", None, None, None, None),
    ("Excel", "csv", "CSV", "Read", None, None, None, "gemini-pro", None, None, None, None),
    ("Excel", None, None, None, None, None, None, "LLAMA-3", None, None, None, None),
    ("Word", "docx", "docx", "Create", None, None, None, "phi-4", None, None, None, "res-lbl"),
    ("Word", "docx", "docx", "Read", None, None, None, "NULL", None, None, None, None),
    ("Word", "docx", "doc", "Summarize", None, None, None, "unknown-model-x", None, None, None, None),
    ("Word", "docx", None, None, None, None, None, None, None, None, None, None),
    ("PowerPoint", "pptx", "pptx", "Write", None, None, None, None, None, None, None, None),
    ("PowerPoint", "pptx", "ppt", "Read", None, None, None, None, None, None, None, None),
    ("PowerPoint", "pptm", None, None, None, None, None, None, None, None, None, None),
    ("BizChat", None, "PeopleInferenceAnswer", None, None, None, None, "OFFENSIVE_FILTER", None, None, None, None),
    ("BizChat", None, "ListItem", "Read", "https://contoso.sharepoint.com/sites/hr", None, None, None, None, None, None, None),
    ("BizChat", None, "aspx", "Read", "https://contoso.sharepoint.com/sites/x/page.aspx", None, None, None, None, None, None, None),
    ("BizChat", None, "WebSearchQuery", None, "https://www.bing.com", "BingWebSearch", "Bing", None, None, None, None, None),
    ("BizChat", None, "pdf", "Read", None, None, None, None, None, None, None, None),
    ("BizChat", None, "py", "Write", None, None, None, None, None, None, None, None),
    ("BizChat", None, "json", "Read", None, None, None, None, None, None, None, None),
    ("Designer", None, "png", "Create", None, None, None, None, None, None, None, None),
    ("BizChat", None, "jpeg", "Read", None, None, None, None, None, None, None, None),
    ("Stream", "StreamVideo", "mp4", "Read", None, None, None, None, None, None, None, None),
    ("Planner", None, "PlanId", "Read", None, None, None, None, None, None, None, None),
    ("Loop", None, "LoopPage", "Read", None, None, None, None, None, None, None, None),
    ("BizChat", None, "http://schema.skype.com/HyperLink", None, "https://github.com/org/repo", None, None, None, None, None, None, None),
    ("BizChat", None, "http://schema.skype.com/HyperLink", None, "https://learning.cloud.microsoft/x", None, None, None, None, None, None, None),
    ("BizChat", None, "http://schema.skype.com/HyperLink", None, "https://contoso.sharepoint.com/a", None, None, None, None, None, None, None),
    ("BizChat", None, "http://schema.skype.com/HyperLink", None, "https://news.example.invalid", None, None, None, None, None, None, None),
    ("BizChat", None, "External", None, None, None, None, None, None, None, None, None),
    ("BizChat", None, "Http", "Invoke", None, None, None, None, None, None, None, None),
    ("BizChat", None, None, None, "https://contoso.service-now.com/x", None, None, None, None, None, None, None),
    ("BizChat", None, None, None, "https://org.crm.dynamics.com", None, None, None, None, None, None, None),
    ("BizChat", None, None, "ExecuteDatasetQuery", None, None, None, None, None, None, None, None),
    ("BizChat", None, None, None, None, "EnterpriseSearch", "Enterprise search", None, None, None, None, None),
    ("BizChat", None, None, None, None, "WebPlugin", "Web", None, None, None, None, None),
    ("BizChat", None, None, None, None, None, None, None, None, None, None, None),
    ("SharePoint", None, None, None, None, None, None, None, None, None, None, None),
    ("OneNote", None, None, None, None, None, None, None, None, None, None, None),
    ("Forms", None, None, None, None, None, None, None, None, None, None, None),
    ("Whiteboard", None, None, None, None, None, None, None, None, None, None, None),
    ("Power BI", None, None, None, None, None, None, None, None, None, None, None),
    ("Copilot Studio", None, None, None, None, None, None, None, "Coach Bot", "T_coach.v1", None, None),
    (" Teams ", "aspx", None, None, None, None, None, None, None, None, None, None),
    # Agents and workflows (index 49 onwards)
    ("Copilot Studio", None, None, None, None, None, None, None, "Sales Helper", "CopilotStudio.Declarative.T_sales.1", None, None),
    ("BizChat", None, None, None, None, None, None, None, "Research Analyst", None, None, None),
    ("BizChat", None, None, None, None, None, None, None, "HR Onboarding Buddy", None, None, None),
    ("BizChat", None, None, None, None, None, None, None, "Policy Checker", None, None, None),
    ("BizChat", None, None, None, None, None, None, None, "IT Support", None, None, None),
    ("BizChat", None, None, None, None, None, None, None, "Draft Writer", None, None, None),
    ("BizChat", None, None, None, None, None, None, None, "Dashboard Bot", None, None, None),
    ("BizChat", None, None, None, None, None, None, None, "Wiki Buddy", None, None, None),
    ("BizChat", None, None, None, None, None, None, None, "Brainstorm Pal", None, None, None),
    ("BizChat", None, None, None, None, None, None, None, "Mystery Agent", GUID_A, None, None),
    ("BizChat", None, None, None, None, None, None, None, "Coder Agent", None, None, None),
    ("BizChat", None, None, None, None, None, None, None, "Painter Agent", None, None, None),
    ("BizChat", None, None, None, None, None, None, None, "Files Agent", None, None, None),
    ("BizChat", None, None, None, None, None, None, None, "Plain Agent", GUID_B, None, None),
    ("BizChat", None, None, None, None, None, None, None, "Scout", None, None, None),
    ("Autonomous", None, "Flow", "SendEmail", "https://outlook.office.com", None, None, None, "Mail Flow", None, None, None),
    ("Autonomous", None, None, None, None, None, None, None, None, None, None, None),
    ("Logic App", None, "Connector", "CreateItem", "https://contoso.sharepoint.com/list", None, None, None, "List Flow", None, None, None),
    ("Logic App", None, None, None, None, None, None, None, None, None, None, None),
    ("Autonomous", None, "Flow", "Invoke", "https://contoso.service-now.com", None, None, None, "SNOW Flow", None, None, None),
    ("Autonomous", None, "Flow", "UpdateRecord", "https://calendar.example.invalid", None, None, None, "Calendar Flow", None, None, None),
    ("Autonomous", None, "Flow", "GetRows", "https://app.powerbi.com", None, None, None, "Report Flow", None, None, None),
    ("Autonomous", None, "Flow", "DeleteFile", None, None, None, None, "Approve Flow", None, None, None),
    ("Autonomous", None, "Flow", None, None, None, None, None, "Nothing Flow", None, None, None),
    ("Cowork", None, None, None, None, None, None, None, None, None, None, None),
    ("BizChat", None, None, None, None, None, None, None, "Cowork Researcher", None, None, None),
]

# (user, active days as (month, day)). The counts are chosen to land users in each User_Stage.
USERS = [
    ("power@example.invalid", [(9, d) for d in range(1, 17)]),
    ("agentic@example.invalid", [(9, d) for d in range(1, 12)]),
    ("habit@example.invalid", [(9, d) for d in range(1, 10)]),
    ("develop@example.invalid", [(9, 1), (9, 2), (9, 3), (9, 4)]),
    ("beginner@example.invalid", [(9, 7)]),
    ("unlicensed@example.invalid", [(8, 30), (8, 31), (9, 1)]),
    ("MixedCase@Example.Invalid", [(9, 6), (9, 7)]),
    ("SecurityCopilotAgentUser-123@example.invalid", [(9, 2)]),
    (None, [(9, 3)]),
    ("", [(9, 3)]),
]


def iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%d %H:%M:%S")


def modern_rows():
    rows = []
    n = 0
    for u_idx, (user, days) in enumerate(USERS):
        heavy = bool(user) and user.startswith(("power", "agentic", "habit"))
        for d_idx, (month, day) in enumerate(days):
            for k in range(3 if heavy else 2):
                s = S[(u_idx * 7 + d_idx * 3 + k) % len(S)]
                if user == "agentic@example.invalid" and k == 0:
                    s = S[49 + (d_idx % 6)]          # agent rows
                if user == "agentic@example.invalid" and k == 1:
                    s = S[1 + (d_idx % 2) * 7]       # producing rows
                n += 1
                # Late-evening times check that dates are taken in UTC.
                created = datetime(2026, month, day, [9, 13, 23][k % 3], 30 if k == 2 else 0, k)
                host, ctx, rtype, ract, url, pid, pname, model, aname, aid, lbl, rlbl = s
                title = entra = None
                if aid:
                    if "CopilotStudio.Declarative." in aid:
                        title = aid.split("CopilotStudio.Declarative.")[1].split(".")[0]
                    elif aid.startswith(("P_", "T_")):
                        title = aid.split(".")[0]
                    elif len(aid) == 36:
                        entra = aid
                day_ = created.date()
                rid = f"rec-{n:04d}"
                rows.append([
                    f"id-{n:04d}", rid, f"rid:{rid}", f"msg:{n}",
                    "resource:none" if rtype is None else f"res:{n}",
                    iso(created), aid, aname,
                    "app-1" if n % 4 == 0 else None, "Copilot" if n % 4 == 0 else None, None,
                    "Microsoft 365 Copilot" if n % 2 else None, "GBR" if n % 3 else None,
                    user, None if user is None else user.strip().lower(), "Copilot",
                    host, f"thread-{n % 11}", lbl, ctx, pid, pname, model,
                    rtype, ract, url, rlbl,
                    f"m-{n}", "true", 0, 0, 1 if rtype else 0,
                    day_.isoformat(), (day_ - timedelta(days=day_.weekday())).isoformat(),
                    day_.replace(day=1).isoformat(),
                    title, entra,
                ])
    # A duplicate source row must stay a duplicate. Also add a row with a NULL CreationDate.
    rows.append(list(rows[0]))
    tail = list(rows[5])
    tail[0], tail[5] = "id-nulldate", None
    rows.append(tail)
    return rows + slim_rows()


# Model-slimming edge cases: Cowork sessions, per-thread / per-message grouping (case variants,
# NULL and blank ids), every work-shape step, surface lists, model tiers and prompt flags.
# They use their own users, threads and messages so the rows above keep their outputs.
# (ThreadId, Message_Id, AppHost, ResType, ResAction, Model, isPrompt, AgentId)
SLIM = [
    ("cw-1", "cw-m1", "Cowork", "message/rfc822", "Send", None, None, None),
    ("cw-1", "cw-m1", "Cowork", "application/vnd.ms-outlook", "Read", None, None, None),
    ("cw-1", "cw-m2", "Cowork", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Write", None, None, None),
    ("cw-1", "cw-m2", "Cowork", "text/csv", "Read", None, None, None),
    ("cw-1", "cw-m3", "Cowork", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "read", None, None, None),
    ("cw-1", "cw-m3", "Cowork", "text/markdown", "Create", None, None, None),
    ("cw-1", "cw-m4", "Cowork", "message", "Read", None, None, None),
    ("cw-1", "cw-m4", "Cowork", "message", "Read", None, None, None),
    ("CW-1", "cw-m5", "Cowork", None, None, None, None, None),
    ("cw-1", "cw-m6", "cowork", "image/png", "Create", None, None, None),
    ("cw-1", "CW-M6", "Cowork", "message", "Read", None, None, None),
    ("cw-1", "cw-m7", "Cowork", "  Application/PDF  ", "Read", None, None, None),
    ("cw-1", "cw-m8", "Cowork", "application/json", "Read", None, None, None),
    ("cw-1", "cw-m9", "Cowork", "image/gif", "Read", None, None, None),
    ("cw-1", "cw-m10", "Cowork", "application/vnd.ms-powerpoint", "Read", None, None, None),
    ("cw-1", "cw-m11", "Cowork", "application/rtf", "Write", None, None, None),
    ("cw-1", "cw-m12", "Cowork", "application/msword", "  read ", None, None, None),
    ("cw-1", "cw-m13", "Cowork", "text/plain", "Read", None, None, None),
    ("cw-1", "cw-m14", "Cowork", "application/zip", "Read", None, None, None),
    ("cw-2", "cw-m20", "Cowork", "message", "Read", None, None, None),
    ("cw-3", "cw-m30", "Cowork", None, None, None, None, None),
    ("cw-3", "cw-m31", "Cowork", "text/html", "Read", None, None, None),
    ("cw-4", "cw-m40", "Cowork", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "Read", None, None, None),
    ("cw-4", "cw-m41", "Cowork", "", "Read", None, None, None),
    ("st-surf", "st-m1", "Word", "docx", "Read", "claude-opus-4.1", "TRUE", None),
    ("st-surf", "st-m2", "Excel", "xlsx", "Write", "gpt-5", "1", None),
    ("st-surf", "st-m3", "  Microsoft   Teams ", "teamsmessage", "Read", "gpt-6", " true ", None),
    ("st-surf", "st-m4", "microsoft teams", "pdf", "Read", "claude-3-haiku", "false", None),
    ("st-surf", "st-m5", "Outlook", "eml", "Read", "o3", None, None),
    ("st-build", "st-m6", "BizChat", "zip", "Read", None, "True", None),
    ("st-many", "st-m7", "Word", "docx", "Read", None, "true", None),
    ("st-many", "st-m8", "Word", "docx", "Read", None, "true", None),
    ("st-many", "st-m9", "Word", " DOCX", "Read", None, "true", None),
    ("st-many", "st-m10", "Word", "docx", "Read", None, "true", None),
    ("st-many", "st-m11", "Word", "docx", "Read", None, "true", None),
    ("st-many", "st-m12", "Word", "docx", "Read", None, "true", None),
    ("st-mod", "st-m13", "Word", "docx", "Read", None, "true", None),
    ("st-mod", "st-m14", "Word", "docx", "Read", None, "true", None),
    ("st-mod", "st-m15", "Word", "doc", "Read", None, "true", None),
    ("st-one", "st-m16", "Word", "docx", "Read", None, "true", "   "),
    ("st-chat", "st-m17", "BizChat", "ListItem", "Read", None, "true", None),
    ("st-chat", "st-m18", "BizChat", "md", "Read", None, "true", None),
    ("st-syn", "st-m19", "BizChat", "md", "Read", None, "true", None),
    ("st-syn", "st-m20", "BizChat", "loop", "Read", None, "true", None),
    ("st-syn", "st-m21", "BizChat", "aspx", "Read", None, "true", None),
    ("Case-Thread", "st-m22", "BizChat", None, None, None, "true", None),
    ("case-thread", "st-m23", "BizChat", None, None, None, "true", None),
    ("", "st-m24", "BizChat", "docx", "Read", None, "true", None),
    ("", "", "BizChat", "xlsx", "Read", None, "true", None),
    (None, None, "BizChat", "pptx", "Read", None, "true", None),
    (None, None, None, "pdf", "Read", None, "true", "T_slim.agent"),
    ("st-mixed", "st-m25", "Cowork", "message", "Read", None, None, None),
    ("st-mixed", "st-m26", "BizChat", None, None, None, "true", None),
]


def slim_rows():
    rows = []
    for i, (thread, msg, host, rtype, ract, model, prompt, aid) in enumerate(SLIM):
        n = 9000 + i
        created = datetime(2026, 9, 10 + i % 3, 10, i % 60, 0)
        day_ = created.date()
        rid = f"rec-{n:04d}"
        rows.append([
            f"id-{n:04d}", rid, f"rid:{rid}", f"msg:{n}",
            "resource:none" if rtype is None else f"res:{n}",
            iso(created), aid, None, None, None, None, None, None,
            "slim@example.invalid" if i % 2 else "cowork@example.invalid",
            "slim@example.invalid" if i % 2 else "cowork@example.invalid", "Copilot",
            host, thread, None, None, None, None, model,
            rtype, ract, None, None,
            msg, prompt, 0, 0, 1 if rtype else 0,
            day_.isoformat(), (day_ - timedelta(days=day_.weekday())).isoformat(),
            day_.replace(day=1).isoformat(),
            None, None,
        ])
    return rows


LICENSED_UPN = {
    "columns": [("User Principal Name", "string"), ("Has license", "string"), ("Department", "string")],
    "rows": [
        [" Power@example.invalid ", "Yes", "Sales"],
        ["power@example.invalid", "Yes", "Sales"],
        ["agentic@example.invalid", "TRUE", "Ops"],
        ["habit@example.invalid", "1", "Ops"],
        ["develop@example.invalid", "y", "HR"],
        ["beginner@example.invalid", "Yes", "HR"],
        ["unlicensed@example.invalid", "No", "Finance"],
        ["mixedcase@example.invalid", "Yes", "Finance"],
        ["", "Yes", "Blank"],
        [None, "Yes", "Null"],
    ],
}

AGENT_COLUMNS = [
    ("Title ID", "string"), ("Entra Agent ID", "string"), ("Agent name", "string"),
    ("Agent description", "string"), ("Custom actions", "string"), ("Can use code interpreter", "string"),
    ("Can generate images using user prompt", "string"), ("Can read Sharepoint sites and files", "string"),
    ("Agent type (A365)", "string"),
]
AGENTS_FULL = {
    "columns": AGENT_COLUMNS,
    "rows": [
        ["T_coach", None, "Coach Bot", "Career coaching", None, "No", "No", "No", "Declarative"],
        ["T_sales", None, "Sales Helper", None, None, "No", "No", "No", "Declarative"],
        ["T_mystery", GUID_A, "Mystery Agent", "Helps you brainstorm ideas", None, "No", "No", "No", "Declarative"],
        ["T_coder", None, "Coder Agent", "General helper", None, "Yes", "No", "No", "Declarative"],
        ["T_painter", None, " painter agent ", "General helper", None, "No", "Yes", "No", "Declarative"],
        ["T_files", None, "Files Agent", "General helper", None, "No", "No", "Yes", "Declarative"],
        ["T_plain", GUID_B, "Plain Agent", "Nothing in particular", "Look up tickets", "No", "No", "No", "Autonomous"],
        ["T_kb", None, "Unused Agent", "Product handbook", None, "No", "No", "No", "Declarative"],
        ["", None, "Blank Title", None, None, None, None, None, None],
        ["T_coach", None, "Coach Bot", "Career coaching", None, "No", "No", "No", "Declarative"],
    ],
}

LICENSED_NORMALIZED = {
    "columns": [("UPN_Normalized", "string"), ("Has license", "string")],
    "rows": [["licensed@example.invalid", "Yes"], ["licensed@example.invalid", "Yes"],
             ["unlicensed@example.invalid", "No"]],
}
AGENTS_MIN = {
    "columns": [("Title ID", "string"), ("Entra Agent ID", "string"), ("Agent name", "string")],
    "rows": [["title-1", "entra-1", "Agent One"], ["title-1", "entra-1", "Agent One"],
             ["title-2", "entra-2", "Agent Two"]],
}

# Older exports carry the raw JSON columns. These are the edge cases the Spark parser must survive.
PAYLOADS = [
    ('[{"Type":"docx","Action":"Read","SiteUrl":"https://example.invalid",'
     '"type":"case-variant","SensitivityLabelId":"raw-only","Rare":{"x":[1,null,true]},'
     '"a.b":"dot","odd key":"space"},'
     '{"Type":"xlsx","Action":"Write","FileName":"second.xlsx"}]',
     '{"Id":"plugin-1","Name":"Plugin","id":"lowercase","Extra":{"a":[1,null]}}'),
    ('[]', '[]'), (None, None), ('', ''), ('null', 'null'), ('[null]', '[null]'),
    ('[{}]', '{}'), ('not-json', 'broken'),
    ('[{"Type":42,"Action":true,"Extra":[1,"mixed",null]}]',
     '[{"Id":"first","Name":"First","Extra":1},{"Id":"second","Extra":{"z":2}}]'),
    ('{"Type":"object-shape","Extra":"keep"}', '{"Name":"no-id","Extra":null}'),
    ('[{"Type":null,"Action":null,"Extra":{"nested":null}}]', '[{},{"Name":"second"}]'),
    ('  [ {"Type":"pptx","Extra":"whitespace"} ]  ', '  {"Id":"spaced","Extra":false}  '),
    ('[{"Type":{"mixed":"object"},"Extra":123}]', '{"Id":123,"Extra":[true,{}]}'),
    ('[1, {"Type":"after-scalar"}]', '[1]'),
    ('"just a string"', '"just a string"'),
    ('42', '42'),
    ('[{"Type":"a"},{"Type":"b"},{"Type":"c"}]', '[{"Id":"x","Name":"X"}]'),
    ('[{"Type":"pdf","Action":"Read"}]', '{"Id":"EnterpriseSearch","Name":"ES"}'),
]


def legacy():
    cols = [("Id", "string"), ("CreationDate", "string"), ("Audit_UserId", "string"),
            ("Audit_UserId_Normalized", "string"), ("AccessedResources", "string"),
            ("AISystemPlugin", "string"), ("AppIdentity", "string"),
            ("AccessedResource_SensitivityLabelId", "string"), ("AppHost", "string"),
            ("AgentName", "string"), ("Agent_EntraId", "string"), ("AgentId", "string"),
            ("TenantField", "string")]
    stamps = ["2026-09-01T12:00:00Z", "2026-09-06T23:30:00Z", "2026-09-07T00:15:00+01:00",
              "2026-08-31 08:00:00", "2026-09-02T10:11:12.345Z", "not-a-date"]
    rows = []
    for i, (resources, plugin) in enumerate(PAYLOADS):
        normalized = {2: None, 3: "", 4: "masked-identity", 5: " MixedCase "}.get(
            i, "licensed@example.invalid")
        rows.append([f"row-{i}", stamps[i % len(stamps)], " LICENSED@example.invalid ",
                     normalized, resources, plugin, '{"appId":"app","unknown":null}',
                     "canonical-label" if i % 2 else None, ["Teams", "Word", "Autonomous"][i % 3],
                     "Agent One" if i % 4 else " agent two ",
                     "entra-1" if i % 3 == 0 else None,
                     "title-1.suffix" if i % 3 == 1 else (" title-2 " if i % 3 == 2 else None),
                     "tenant-value"])
    rows.append(list(rows[0]))
    return {"columns": cols, "rows": rows}


def minimal(with_id=True):
    cols = [("Id", "string"), ("CreationDate", "string"), ("Audit_UserId", "string")]
    rows = [["minimal", "2026-09-02T12:00:00Z", "unlicensed@example.invalid"]]
    if not with_id:
        cols, rows = cols[1:], [r[1:] for r in rows]
    return {"columns": cols, "rows": rows}


# Agent link, agent type and exclusion branches: parsed rows as the current ingester writes them.
BOT_LOB = "aaaaaaaa-0000-4000-8000-000000000001"
BOT_BUILDER = "aaaaaaaa-0000-4000-8000-000000000002"
ENTRA_1 = "bbbbbbbb-0000-4000-8000-000000000001"
TITLE_GUID = "cccccccc-0000-4000-8000-000000000001"
SCHEMA_GUID = "dddddddd-0000-4000-8000-000000000001"
RUNTIME_COLUMNS = [
    ("Id", "string"), ("CreationDate", "string"), ("Audit_UserId", "string"), ("AgentId", "string"),
    ("AgentName", "string"), ("AgentPlatform", "string"), ("PlatformAgentId", "string"),
    ("AppIdentity_Text", "string"), ("Agent_TargetPlatformId", "string"), ("Agent_TargetName", "string"),
    ("Agent_PlatformType", "string"), ("AppHost", "string"), ("Workload", "string"),
    ("Prompts_Available", "string"), ("Agent_BotId", "string"),
]
# (AgentId, AgentName, AgentPlatform, PlatformAgentId, AppIdentity_Text, Agent_TargetPlatformId,
#  Agent_TargetName, Agent_PlatformType, AppHost, Workload, Prompts_Available, Agent_BotId)
RUNTIME_SCENARIOS = [
    (None, "HR Helper", "Copilot Studio", f"Default-env-01_{BOT_LOB.upper()}", f"Copilot.Studio.{BOT_LOB}",
     None, "HR Helper", None, "Teams", "Copilot", "FALSE", None),
    ("T_shared1", "HR Helper (shared)", None, None, None, None, None, None, "Teams", "Copilot", "TRUE", None),
    (ENTRA_1, "Entra Agent", None, None, None, None, None, None, "Word", "Copilot", "TRUE", None),
    (f"T_{TITLE_GUID}.{SCHEMA_GUID}", "Schema Agent", None, None, None, None, None, None, "Teams", "Copilot",
     "TRUE", None),
    (SCHEMA_GUID, None, None, None, None, None, None, None, "Teams", "Copilot", "TRUE", None),
    ("T_unknown", "Unknown Agent", None, None, None, None, None, None, "Teams", "Copilot", "TRUE", None),
    (None, None, None, BOT_BUILDER.upper(), None, None, "Builder Agent", None, "Teams", "Copilot", None, None),
    (None, "Bot Direct", None, None, None, None, None, None, "Teams", "Copilot", "TRUE", f" {BOT_BUILDER.upper()} "),
    (None, "Researcher", None, None, "MicrosoftAgent.Researcher.P_abc", None, None, None, "Teams", "Copilot",
     "TRUE", None),
    ("BuiltIn_Analyst", None, None, None, None, None, None, None, "Teams", "Copilot", "TRUE", None),
    (None, None, None, None, "Copilot.TeamCopilot.Facilitator", None, None, None, "Teams", "Copilot", "TRUE", None),
    ("ignored", "Custom Engine", None, None, None, "CustomEngine_abc", "Engine Target", None, "Teams", "Copilot",
     "TRUE", None),
    ("CopilotStudio.Declarative.T_decl1.abc", "Declarative Agent", None, None, None, None, None, None, "Word",
     "Copilot", "TRUE", None),
    ("U_shared9", "Shared By Me", None, None, None, None, None, None, "Teams", "Copilot", "TRUE", None),
    ("P_store1", "Store Agent", None, None, None, None, None, None, "Teams", "Copilot", "TRUE", None),
    (None, None, None, None, "ConnectedAIApp.ExampleApp", None, None, None, None, "ConnectedAIApp", "TRUE", None),
    (None, "Chat App", None, None, "AIApp.ChatApp", None, None, None, None, "AIApp", "TRUE", None),
    (None, None, None, None, None, None, None, " Copilot Studio ", "Teams", "Copilot", "TRUE", None),
    (None, "Kind Only", None, None, None, None, None, "Copilot Studio", "Teams", "Copilot", "TRUE", None),
    (None, "Inside M365", None, None, "Copilot.M365Copilot.Chat", None, None, None, "M365Copilot", "Copilot",
     "TRUE", None),
    (None, None, None, None, None, None, None, None, "Teams", "Copilot", "TRUE", None),
    # Excluded rows (Exclude_Reason in DROP_EXCLUDE_REASONS).
    ("T_test", "Test Pane", None, None, None, None, None, None, "Copilot Studio", "Copilot", "TRUE", None),
    ("T_eval", "Eval", None, None, None, None, None, None, " PVA-Maker-Evaluation ", "Copilot", "TRUE", None),
    ("T_auth", "Authoring", None, None, None, None, None, None, "agentic-builder", "Copilot", "TRUE", None),
    ("T_auto", "Auto", None, None, None, None, None, None, "Autonomous", "Copilot", "TRUE", None),
    ("T_flow", "Flow", None, None, None, None, None, None, "workflow-agents", "Copilot", "TRUE", None),
    (None, "Twin", "CopilotStudio", None, None, None, None, None, "m365copilot", "Copilot", " false ", None),
    ("00000000-0000-0000-0000-000000000000", "Multi", None, None, None, None, None, None, "Teams", "Copilot",
     "TRUE", None),
]


def agent_runtime():
    rows = []
    for i, s in enumerate(RUNTIME_SCENARIOS):
        rows.append([f"rt-{i:02d}", f"2026-10-{1 + i % 20:02d}T09:00:00Z", f"user{i % 4}@example.invalid", *s])
    return {"columns": RUNTIME_COLUMNS, "rows": rows}


AGENTS_LINK = {
    "columns": [("Title ID", "string"), ("Bot Id", "string"), ("Entra Agent ID", "string"),
                ("Agent name", "string"), ("Agent type (A365)", "string"), ("Created in", "string"),
                ("Last updated", "string")],
    "rows": [
        ["T_lob1", BOT_LOB.upper(), None, "HR Helper", "LOB", "Copilot Studio", "2026-01-02"],
        ["T_shared1", BOT_LOB, None, "HR Helper", "Shared", "Copilot Studio", "2026-02-01"],
        ["T_entra1", None, ENTRA_1, "Entra Agent", "LOB", "Copilot Studio", "2026-01-05"],
        [f"T_{TITLE_GUID}", None, None, "Schema Agent", "Declarative", "Agent Builder", "2026-01-06"],
        ["T_builder1", BOT_BUILDER, None, "Builder Agent", "LOB", "Agent Builder", "2026-01-01"],
        ["T_builder2", BOT_BUILDER, None, "Builder Agent", "LOB", "Agent Builder", "2026-03-01"],
    ],
}


def dump(name, table):
    INPUTS.mkdir(parents=True, exist_ok=True)
    payload = {"columns": [list(c) for c in table["columns"]], "rows": table["rows"]}
    for row in payload["rows"]:
        assert len(row) == len(payload["columns"]), (name, row)
    (INPUTS / f"{name}.json").write_text(
        json.dumps(payload, indent=1, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")


def main():
    dump("modern_interactions", {"columns": MODERN_COLUMNS, "rows": modern_rows()})
    dump("licensed_upn", LICENSED_UPN)
    dump("agents_full", AGENTS_FULL)
    dump("legacy_interactions", legacy())
    dump("licensed_normalized", LICENSED_NORMALIZED)
    dump("agents_min", AGENTS_MIN)
    dump("minimal_interactions", minimal())
    dump("minimal_no_id_interactions", minimal(with_id=False))
    dump("empty_interactions", {"columns": minimal()["columns"], "rows": []})
    dump("agent_runtime_interactions", agent_runtime())
    dump("agents_link", AGENTS_LINK)


if __name__ == "__main__":
    main()
