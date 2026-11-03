-- V011: Azure Resource Graph agent detail (module `resourceGraph`): per Copilot Studio agent, what the
-- Governance pages need beyond arg_agent_config (components, knowledge by type, editors, creator), and
-- whether the owner's account is still active (Microsoft Graph). It lets Governance work without Agent 365.
-- Created up front so a model refresh before the first collection finds an empty table; the publish step
-- fills it. Types follow publish.TYPE_MAP and resource_graph.ARG_SCHEMAS (enforced by
-- tests/test_resource_graph.py).

IF OBJECT_ID(N'dbo.arg_agent_detail', N'U') IS NULL
CREATE TABLE dbo.arg_agent_detail (
    [SnapshotDate] DATE NULL,
    [AgentResourceId] NVARCHAR(4000) NULL,
    [CreatedBy] NVARCHAR(4000) NULL,
    [QuarantinedAt] NVARCHAR(4000) NULL,
    [TopicCount] BIGINT NULL,
    [ToolCount] BIGINT NULL,
    [KnowledgeCount] BIGINT NULL,
    [EditorUserCount] BIGINT NULL,
    [EntraAgentBlueprintId] NVARCHAR(4000) NULL,
    [Harness] NVARCHAR(4000) NULL,
    [InstructionsCharCount] BIGINT NULL,
    [KnowledgeTypes] NVARCHAR(4000) NULL,
    [SharePointSiteCount] BIGINT NULL,
    [GraphConnectorCount] BIGINT NULL,
    [PublicSiteCount] BIGINT NULL,
    [FileKnowledgeCount] BIGINT NULL,
    [DataverseSourceCount] BIGINT NULL,
    [OwnerAccount] NVARCHAR(4000) NULL,
    [OwnerUpn] NVARCHAR(4000) NULL,
    [Source] NVARCHAR(4000) NULL
);
GO

IF NOT EXISTS (SELECT 1 FROM dbo.schema_version WHERE version = 11)
INSERT dbo.schema_version (version, description) VALUES (11, N'resourceGraph: Agent detail and owner accounts');
GO
