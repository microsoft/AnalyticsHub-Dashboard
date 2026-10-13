-- V006: agent link and agent type columns on the curated fact, matching the Fabric notebook
-- (Copilot_Audit_Log_Processor.ipynb). The semantic models read Agent_Key, Agent_Type and the rest;
-- without them the model refresh fails. The publish step also adds missing columns, so this is
-- idempotent: each column is added only when it isn't there yet.

IF COL_LENGTH(N'dbo.copilot_interactions_curated', N'AppIdentity_Text') IS NULL
    ALTER TABLE dbo.copilot_interactions_curated ADD [AppIdentity_Text] NVARCHAR(4000) NULL;
GO
IF COL_LENGTH(N'dbo.copilot_interactions_curated', N'Agent_TargetPlatformId') IS NULL
    ALTER TABLE dbo.copilot_interactions_curated ADD [Agent_TargetPlatformId] NVARCHAR(4000) NULL;
GO
IF COL_LENGTH(N'dbo.copilot_interactions_curated', N'Agent_TargetName') IS NULL
    ALTER TABLE dbo.copilot_interactions_curated ADD [Agent_TargetName] NVARCHAR(4000) NULL;
GO
IF COL_LENGTH(N'dbo.copilot_interactions_curated', N'Agent_PlatformType') IS NULL
    ALTER TABLE dbo.copilot_interactions_curated ADD [Agent_PlatformType] NVARCHAR(4000) NULL;
GO
IF COL_LENGTH(N'dbo.copilot_interactions_curated', N'AgentPlatform') IS NULL
    ALTER TABLE dbo.copilot_interactions_curated ADD [AgentPlatform] NVARCHAR(4000) NULL;
GO
IF COL_LENGTH(N'dbo.copilot_interactions_curated', N'PlatformAgentId') IS NULL
    ALTER TABLE dbo.copilot_interactions_curated ADD [PlatformAgentId] NVARCHAR(4000) NULL;
GO
IF COL_LENGTH(N'dbo.copilot_interactions_curated', N'Agent_BotId') IS NULL
    ALTER TABLE dbo.copilot_interactions_curated ADD [Agent_BotId] NVARCHAR(4000) NULL;
GO
IF COL_LENGTH(N'dbo.copilot_interactions_curated', N'Agent_EnvironmentId') IS NULL
    ALTER TABLE dbo.copilot_interactions_curated ADD [Agent_EnvironmentId] NVARCHAR(4000) NULL;
GO
IF COL_LENGTH(N'dbo.copilot_interactions_curated', N'Prompts_Available') IS NULL
    ALTER TABLE dbo.copilot_interactions_curated ADD [Prompts_Available] NVARCHAR(4000) NULL;
GO
IF COL_LENGTH(N'dbo.copilot_interactions_curated', N'Exclude_Reason') IS NULL
    ALTER TABLE dbo.copilot_interactions_curated ADD [Exclude_Reason] NVARCHAR(4000) NULL;
GO
IF COL_LENGTH(N'dbo.copilot_interactions_curated', N'Agent_MatchedTitleID') IS NULL
    ALTER TABLE dbo.copilot_interactions_curated ADD [Agent_MatchedTitleID] NVARCHAR(4000) NULL;
GO
IF COL_LENGTH(N'dbo.copilot_interactions_curated', N'Agent_LinkMethod') IS NULL
    ALTER TABLE dbo.copilot_interactions_curated ADD [Agent_LinkMethod] NVARCHAR(4000) NULL;
GO
IF COL_LENGTH(N'dbo.copilot_interactions_curated', N'Agent_Key') IS NULL
    ALTER TABLE dbo.copilot_interactions_curated ADD [Agent_Key] NVARCHAR(4000) NULL;
GO
IF COL_LENGTH(N'dbo.copilot_interactions_curated', N'Agent_Type') IS NULL
    ALTER TABLE dbo.copilot_interactions_curated ADD [Agent_Type] NVARCHAR(4000) NULL;
GO
IF COL_LENGTH(N'dbo.copilot_interactions_curated', N'Agent_Type_Basis') IS NULL
    ALTER TABLE dbo.copilot_interactions_curated ADD [Agent_Type_Basis] NVARCHAR(4000) NULL;
GO
IF COL_LENGTH(N'dbo.copilot_interactions_curated', N'Agent_Publisher') IS NULL
    ALTER TABLE dbo.copilot_interactions_curated ADD [Agent_Publisher] NVARCHAR(4000) NULL;
GO
IF COL_LENGTH(N'dbo.copilot_interactions_curated', N'Agent_Is_Published') IS NULL
    ALTER TABLE dbo.copilot_interactions_curated ADD [Agent_Is_Published] BIT NULL;
GO
IF COL_LENGTH(N'dbo.copilot_interactions_curated', N'Agent_Consolidated_Name') IS NULL
    ALTER TABLE dbo.copilot_interactions_curated ADD [Agent_Consolidated_Name] NVARCHAR(4000) NULL;
GO
