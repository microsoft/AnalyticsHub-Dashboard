-- V007: model-slimming columns on the curated fact, matching the Fabric notebook (section 10c) and
-- valuelens_core.processor.SLIM_COLS. They replace the ValueLens model's DAX calculated columns (and the
-- unique ThreadId / Message_Id text columns, via Thread_Key / Message_Key), so the model loads them
-- instead of computing them at refresh. Like V006 this is idempotent; the publish step also adds
-- missing columns.

IF COL_LENGTH(N'dbo.copilot_interactions_curated', N'Is_Cowork') IS NULL
    ALTER TABLE dbo.copilot_interactions_curated ADD [Is_Cowork] BIT NULL;
GO
IF COL_LENGTH(N'dbo.copilot_interactions_curated', N'AppHost_Norm') IS NULL
    ALTER TABLE dbo.copilot_interactions_curated ADD [AppHost_Norm] NVARCHAR(4000) NULL;
GO
IF COL_LENGTH(N'dbo.copilot_interactions_curated', N'Agent Filter (Normalized)') IS NULL
    ALTER TABLE dbo.copilot_interactions_curated ADD [Agent Filter (Normalized)] NVARCHAR(4000) NULL;
GO
IF COL_LENGTH(N'dbo.copilot_interactions_curated', N'Session Turn Band') IS NULL
    ALTER TABLE dbo.copilot_interactions_curated ADD [Session Turn Band] NVARCHAR(4000) NULL;
GO
IF COL_LENGTH(N'dbo.copilot_interactions_curated', N'Session Turn Band Sort') IS NULL
    ALTER TABLE dbo.copilot_interactions_curated ADD [Session Turn Band Sort] BIGINT NULL;
GO
IF COL_LENGTH(N'dbo.copilot_interactions_curated', N'Model Cost Tier') IS NULL
    ALTER TABLE dbo.copilot_interactions_curated ADD [Model Cost Tier] NVARCHAR(4000) NULL;
GO
IF COL_LENGTH(N'dbo.copilot_interactions_curated', N'Model Cost Tier Sort') IS NULL
    ALTER TABLE dbo.copilot_interactions_curated ADD [Model Cost Tier Sort] BIGINT NULL;
GO
IF COL_LENGTH(N'dbo.copilot_interactions_curated', N'Work Weight Grade') IS NULL
    ALTER TABLE dbo.copilot_interactions_curated ADD [Work Weight Grade] NVARCHAR(4000) NULL;
GO
IF COL_LENGTH(N'dbo.copilot_interactions_curated', N'Work Weight Grade Sort') IS NULL
    ALTER TABLE dbo.copilot_interactions_curated ADD [Work Weight Grade Sort] BIGINT NULL;
GO
IF COL_LENGTH(N'dbo.copilot_interactions_curated', N'Session Material Refs') IS NULL
    ALTER TABLE dbo.copilot_interactions_curated ADD [Session Material Refs] BIGINT NULL;
GO
IF COL_LENGTH(N'dbo.copilot_interactions_curated', N'Session Material Types') IS NULL
    ALTER TABLE dbo.copilot_interactions_curated ADD [Session Material Types] BIGINT NULL;
GO
IF COL_LENGTH(N'dbo.copilot_interactions_curated', N'Cowork Task Category') IS NULL
    ALTER TABLE dbo.copilot_interactions_curated ADD [Cowork Task Category] NVARCHAR(4000) NULL;
GO
IF COL_LENGTH(N'dbo.copilot_interactions_curated', N'Task Breakdown Category') IS NULL
    ALTER TABLE dbo.copilot_interactions_curated ADD [Task Breakdown Category] NVARCHAR(4000) NULL;
GO
IF COL_LENGTH(N'dbo.copilot_interactions_curated', N'Is Prompt Row') IS NULL
    ALTER TABLE dbo.copilot_interactions_curated ADD [Is Prompt Row] BIT NULL;
GO
IF COL_LENGTH(N'dbo.copilot_interactions_curated', N'Is Observed Prompt') IS NULL
    ALTER TABLE dbo.copilot_interactions_curated ADD [Is Observed Prompt] BIT NULL;
GO
IF COL_LENGTH(N'dbo.copilot_interactions_curated', N'Task Engagement Mode') IS NULL
    ALTER TABLE dbo.copilot_interactions_curated ADD [Task Engagement Mode] NVARCHAR(4000) NULL;
GO
IF COL_LENGTH(N'dbo.copilot_interactions_curated', N'Task Breakdown Group') IS NULL
    ALTER TABLE dbo.copilot_interactions_curated ADD [Task Breakdown Group] NVARCHAR(4000) NULL;
GO
IF COL_LENGTH(N'dbo.copilot_interactions_curated', N'Fit Basis') IS NULL
    ALTER TABLE dbo.copilot_interactions_curated ADD [Fit Basis] NVARCHAR(4000) NULL;
GO
IF COL_LENGTH(N'dbo.copilot_interactions_curated', N'Work Shape') IS NULL
    ALTER TABLE dbo.copilot_interactions_curated ADD [Work Shape] NVARCHAR(4000) NULL;
GO
IF COL_LENGTH(N'dbo.copilot_interactions_curated', N'Work Shape Sort') IS NULL
    ALTER TABLE dbo.copilot_interactions_curated ADD [Work Shape Sort] BIGINT NULL;
GO
IF COL_LENGTH(N'dbo.copilot_interactions_curated', N'Session Model Tier') IS NULL
    ALTER TABLE dbo.copilot_interactions_curated ADD [Session Model Tier] NVARCHAR(4000) NULL;
GO
IF COL_LENGTH(N'dbo.copilot_interactions_curated', N'Session Model Tier Sort') IS NULL
    ALTER TABLE dbo.copilot_interactions_curated ADD [Session Model Tier Sort] BIGINT NULL;
GO
IF COL_LENGTH(N'dbo.copilot_interactions_curated', N'Expertise Role (All Cohorts)') IS NULL
    ALTER TABLE dbo.copilot_interactions_curated ADD [Expertise Role (All Cohorts)] NVARCHAR(4000) NULL;
GO
IF COL_LENGTH(N'dbo.copilot_interactions_curated', N'Is Usage Row') IS NULL
    ALTER TABLE dbo.copilot_interactions_curated ADD [Is Usage Row] BIT NULL;
GO
IF COL_LENGTH(N'dbo.copilot_interactions_curated', N'Thread_Key') IS NULL
    ALTER TABLE dbo.copilot_interactions_curated ADD [Thread_Key] BIGINT NULL;
GO
IF COL_LENGTH(N'dbo.copilot_interactions_curated', N'Message_Key') IS NULL
    ALTER TABLE dbo.copilot_interactions_curated ADD [Message_Key] BIGINT NULL;
GO
