-- V010: Product feedback by CSV (module `productFeedback`): the Fabric Lakehouse table `user_feedback`,
-- as the Copilot_ProductFeedback_Ingester notebook writes it. The columns are text as exported (the
-- model types them), except `Date Submitted Date`, the date of `Date Submitted UTC`; `Sentiment` comes
-- from `Feedback Type`, and `SourceFile` and `LoadDate` record where and when each row was loaded.
-- Created up front so a model refresh before the first export finds an empty table. The publish step
-- replaces the rows and adds any extra export columns. Columns follow collect/product_feedback.COLUMNS
-- (enforced by tests/test_azure_product_feedback.py).

IF OBJECT_ID(N'dbo.user_feedback', N'U') IS NULL
CREATE TABLE dbo.user_feedback (
    [Feedback Id] NVARCHAR(4000) NULL,
    [Comment] NVARCHAR(4000) NULL,
    [Translated Comment] NVARCHAR(4000) NULL,
    [Comment Language] NVARCHAR(4000) NULL,
    [Date Submitted UTC] NVARCHAR(4000) NULL,
    [Feedback Type] NVARCHAR(4000) NULL,
    [Microsoft Response Status] NVARCHAR(4000) NULL,
    [App] NVARCHAR(4000) NULL,
    [App Language] NVARCHAR(4000) NULL,
    [Platform] NVARCHAR(4000) NULL,
    [Source Type] NVARCHAR(4000) NULL,
    [Logs, Attachments] NVARCHAR(4000) NULL,
    [User Id] NVARCHAR(4000) NULL,
    [User Email] NVARCHAR(4000) NULL,
    [Browser] NVARCHAR(4000) NULL,
    [Browser Version] NVARCHAR(4000) NULL,
    [AI Context Prompt] NVARCHAR(4000) NULL,
    [AI Context Response Message] NVARCHAR(4000) NULL,
    [Survey Question] NVARCHAR(4000) NULL,
    [Survey Response Option] NVARCHAR(4000) NULL,
    [Additional Metadata] NVARCHAR(4000) NULL,
    [Date Submitted Date] DATE NULL,
    [Sentiment] NVARCHAR(4000) NULL,
    [SourceFile] NVARCHAR(4000) NULL,
    [LoadDate] NVARCHAR(4000) NULL
);
GO

IF NOT EXISTS (SELECT 1 FROM dbo.schema_version WHERE version = 10)
INSERT dbo.schema_version (version, description) VALUES (10, N'productFeedback: Product feedback (CSV)');
GO
