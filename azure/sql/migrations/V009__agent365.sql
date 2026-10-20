-- V009: Agent 365 registry by CSV (module `agent365`): the Fabric Lakehouse table `agents_365`, as
-- the Copilot_Agent365_Lander notebook writes it. The 37 canonical columns are text as exported
-- (the model types them); `Snapshot As Of` is the latest `Last updated`. Created up front so a model
-- refresh before the first export finds an empty table. The publish step replaces the rows and adds
-- any extra export columns. Columns follow collect/agent365.CANONICAL (enforced by
-- tests/test_azure_agent365.py).

IF OBJECT_ID(N'dbo.agents_365', N'U') IS NULL
CREATE TABLE dbo.agents_365 (
    [Agent name] NVARCHAR(4000) NULL,
    [Supported in] NVARCHAR(4000) NULL,
    [Date created] NVARCHAR(4000) NULL,
    [Agent creator] NVARCHAR(4000) NULL,
    [Publisher] NVARCHAR(4000) NULL,
    [Agent type (A365)] NVARCHAR(4000) NULL,
    [Version] NVARCHAR(4000) NULL,
    [Availability] NVARCHAR(4000) NULL,
    [Agent creator ID] NVARCHAR(4000) NULL,
    [Agent description] NVARCHAR(4000) NULL,
    [Created in] NVARCHAR(4000) NULL,
    [Last updated] NVARCHAR(4000) NULL,
    [Custom actions] NVARCHAR(4000) NULL,
    [Title ID] NVARCHAR(4000) NULL,
    [Sensitivity] NVARCHAR(4000) NULL,
    [Can read OneDrive and Sharepoint items] NVARCHAR(4000) NULL,
    [OneDrive and Sharepoint items] NVARCHAR(4000) NULL,
    [Can read OneDrive files] NVARCHAR(4000) NULL,
    [OneDrive files] NVARCHAR(4000) NULL,
    [OneDrive sites] NVARCHAR(4000) NULL,
    [Can read Sharepoint sites and files] NVARCHAR(4000) NULL,
    [Sharepoint files] NVARCHAR(4000) NULL,
    [Sharepoint sites] NVARCHAR(4000) NULL,
    [Can extend to Graph connector] NVARCHAR(4000) NULL,
    [Graph connector details] NVARCHAR(4000) NULL,
    [Can generate images using user prompt] NVARCHAR(4000) NULL,
    [Can use code interpreter] NVARCHAR(4000) NULL,
    [Contains uploaded files] NVARCHAR(4000) NULL,
    [Uploaded files] NVARCHAR(4000) NULL,
    [Status] NVARCHAR(4000) NULL,
    [Active Users] NVARCHAR(4000) NULL,
    [Total sessions] NVARCHAR(4000) NULL,
    [Exception rate] NVARCHAR(4000) NULL,
    [Last Activity Date] NVARCHAR(4000) NULL,
    [Deployment] NVARCHAR(4000) NULL,
    [Run Time] NVARCHAR(4000) NULL,
    [Risks] NVARCHAR(4000) NULL,
    [Snapshot As Of] DATETIME2(6) NULL
);
GO

IF NOT EXISTS (SELECT 1 FROM dbo.schema_version WHERE version = 9)
INSERT dbo.schema_version (version, description) VALUES (9, N'agent365: Agent 365 registry (CSV)');
GO
