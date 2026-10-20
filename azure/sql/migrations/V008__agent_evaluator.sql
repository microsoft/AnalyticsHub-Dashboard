-- V008: Agent Evaluator (module `agentEvaluator`): Copilot Studio conversation transcripts that the jobs'
-- managed identity reads from Dataverse, parsed as Fabric's Copilot_Agent_Transcript_Parser notebook does.
-- Table and column names match the Fabric Lakehouse tables, so the Agent Evaluator model's navigation works
-- unchanged. The five transcript tables add [transcript_date], the UTC day the conversation started, which
-- publish rewrites day by day (they are clustered on it). Created up front so a model refresh before the first
-- collection finds empty tables; the publish step fills them. Types follow publish.TYPE_MAP and
-- valuelens_jobs.transcripts (enforced by tests/test_azure_agent_evaluator.py).

IF OBJECT_ID(N'dbo.agent_sessions', N'U') IS NULL
CREATE TABLE dbo.agent_sessions (
    [conversation_id] NVARCHAR(4000) NULL,
    [session_start_utc] NVARCHAR(4000) NULL,
    [session_duration_ms] NVARCHAR(4000) NULL,
    [user_id_hash] NVARCHAR(4000) NULL,
    [user_upn] NVARCHAR(4000) NULL,
    [primary_agent_schema] NVARCHAR(4000) NULL,
    [connected_agent_schemas] NVARCHAR(4000) NULL,
    [connected_agent_count] NVARCHAR(4000) NULL,
    [agent_name] NVARCHAR(4000) NULL,
    [agent_id] NVARCHAR(4000) NULL,
    [msg_count] NVARCHAR(4000) NULL,
    [user_msg_count] NVARCHAR(4000) NULL,
    [bot_msg_count] NVARCHAR(4000) NULL,
    [plan_step_count] NVARCHAR(4000) NULL,
    [total_displayed_cost] NVARCHAR(4000) NULL,
    [total_latency_ms] NVARCHAR(4000) NULL,
    [knowledge_searched] NVARCHAR(4000) NULL,
    [knowledge_answered] NVARCHAR(4000) NULL,
    [knowledge_sources_count] NVARCHAR(4000) NULL,
    [grounding_source] NVARCHAR(4000) NULL,
    [error_count] NVARCHAR(4000) NULL,
    [first_error_code] NVARCHAR(4000) NULL,
    [feedback_offered_count] NVARCHAR(4000) NULL,
    [feedback_submitted] NVARCHAR(4000) NULL,
    [feedback_verdict] NVARCHAR(4000) NULL,
    [feedback_comment] NVARCHAR(4000) NULL,
    [first_user_prompt] NVARCHAR(4000) NULL,
    [session_outcome_explicit] NVARCHAR(4000) NULL,
    [session_outcome_reason_explicit] NVARCHAR(4000) NULL,
    [is_authenticated] NVARCHAR(4000) NULL,
    [is_returning_user] NVARCHAR(4000) NULL,
    [primary_topic_derived] NVARCHAR(4000) NULL,
    [source_environment] NVARCHAR(4000) NULL,
    [transcript_date] DATE NULL
);
GO

IF OBJECT_ID(N'dbo.agent_turns', N'U') IS NULL
CREATE TABLE dbo.agent_turns (
    [conversation_id] NVARCHAR(4000) NULL,
    [turn_id] NVARCHAR(4000) NULL,
    [turn_timestamp_utc] NVARCHAR(4000) NULL,
    [turn_role] NVARCHAR(4000) NULL,
    [turn_channel] NVARCHAR(4000) NULL,
    [from_user_hash] NVARCHAR(4000) NULL,
    [text_preview_500] NVARCHAR(4000) NULL,
    [text_length] NVARCHAR(4000) NULL,
    [intent_title] NVARCHAR(4000) NULL,
    [intent_id] NVARCHAR(4000) NULL,
    [intent_score] NVARCHAR(4000) NULL,
    [knowledge_searched] NVARCHAR(4000) NULL,
    [knowledge_answered] NVARCHAR(4000) NULL,
    [knowledge_sources] NVARCHAR(4000) NULL,
    [feedback_offered] NVARCHAR(4000) NULL,
    [feedback_verdict] NVARCHAR(4000) NULL,
    [feedback_comment] NVARCHAR(4000) NULL,
    [source_environment] NVARCHAR(4000) NULL,
    [transcript_date] DATE NULL
);
GO

IF OBJECT_ID(N'dbo.agent_errors', N'U') IS NULL
CREATE TABLE dbo.agent_errors (
    [conversation_id] NVARCHAR(4000) NULL,
    [error_timestamp_utc] NVARCHAR(4000) NULL,
    [error_code] NVARCHAR(4000) NULL,
    [error_sub_code] NVARCHAR(4000) NULL,
    [error_message] NVARCHAR(4000) NULL,
    [is_user_error] NVARCHAR(4000) NULL,
    [source_environment] NVARCHAR(4000) NULL,
    [transcript_date] DATE NULL
);
GO

IF OBJECT_ID(N'dbo.agent_subagents', N'U') IS NULL
CREATE TABLE dbo.agent_subagents (
    [conversation_id] NVARCHAR(4000) NULL,
    [invocation_timestamp_utc] NVARCHAR(4000) NULL,
    [event_type] NVARCHAR(4000) NULL,
    [parent_agent_schema] NVARCHAR(4000) NULL,
    [connected_agent_schema] NVARCHAR(4000) NULL,
    [dialog_schema] NVARCHAR(4000) NULL,
    [user_id_hash] NVARCHAR(4000) NULL,
    [plan_step_id] NVARCHAR(4000) NULL,
    [source_environment] NVARCHAR(4000) NULL,
    [transcript_date] DATE NULL
);
GO

IF OBJECT_ID(N'dbo.agent_performance', N'U') IS NULL
CREATE TABLE dbo.agent_performance (
    [ConversationTranscriptId] NVARCHAR(4000) NULL,
    [ConversationStartTime] NVARCHAR(4000) NULL,
    [SchemaVersion] NVARCHAR(4000) NULL,
    [BotName] NVARCHAR(4000) NULL,
    [BotId] NVARCHAR(4000) NULL,
    [AADTenantId] NVARCHAR(4000) NULL,
    [BatchId] NVARCHAR(4000) NULL,
    [SessionStartTimeUtc] NVARCHAR(4000) NULL,
    [SessionEndTimeUtc] NVARCHAR(4000) NULL,
    [SessionType] NVARCHAR(4000) NULL,
    [SessionOutcome] NVARCHAR(4000) NULL,
    [TurnCount] NVARCHAR(4000) NULL,
    [OutcomeReason] NVARCHAR(4000) NULL,
    [ImpliedSuccess] NVARCHAR(4000) NULL,
    [LastUserIntentId] NVARCHAR(4000) NULL,
    [IsDesignMode] NVARCHAR(4000) NULL,
    [Locale] NVARCHAR(4000) NULL,
    [UserMessageCount] NVARCHAR(4000) NULL,
    [BotMessageCount] NVARCHAR(4000) NULL,
    [TotalMessageCount] NVARCHAR(4000) NULL,
    [FirstUserMessage] NVARCHAR(4000) NULL,
    [LastUserMessage] NVARCHAR(4000) NULL,
    [FirstBotMessage] NVARCHAR(4000) NULL,
    [LastBotMessage] NVARCHAR(4000) NULL,
    [TopicsTriggered] NVARCHAR(4000) NULL,
    [TopicCount] NVARCHAR(4000) NULL,
    [PrimaryTopic] NVARCHAR(4000) NULL,
    [DurationSeconds] NVARCHAR(4000) NULL,
    [AverageLatencyMs] NVARCHAR(4000) NULL,
    [Var_ESS_UserContext_UPN] NVARCHAR(4000) NULL,
    [Var_ESS_Message_Disclaimer] NVARCHAR(4000) NULL,
    [Var_ESS_UserContext_RefreshInterval_Hours] NVARCHAR(4000) NULL,
    [Var_ESS_UserContext_Conversation_Initialized] NVARCHAR(4000) NULL,
    [AllVariables] NVARCHAR(4000) NULL,
    [TotalActivityCount] NVARCHAR(4000) NULL,
    [TraceActivityCount] NVARCHAR(4000) NULL,
    [EventActivityCount] NVARCHAR(4000) NULL,
    [StatusCode] NVARCHAR(4000) NULL,
    [StateCode] NVARCHAR(4000) NULL,
    [FirstErrorCode] NVARCHAR(4000) NULL,
    [ErrorCategory] NVARCHAR(4000) NULL,
    [IsAuthenticated] NVARCHAR(4000) NULL,
    [MultiAgentSession] NVARCHAR(4000) NULL,
    [SessionOutcomeExplicit] NVARCHAR(4000) NULL,
    [SessionOutcomeReasonExplicit] NVARCHAR(4000) NULL,
    [GenerativeResponseCount] NVARCHAR(4000) NULL,
    [LLMCallCount] NVARCHAR(4000) NULL,
    [PromptTokenCount] NVARCHAR(4000) NULL,
    [CompletionTokenCount] NVARCHAR(4000) NULL,
    [TotalTokenCount] NVARCHAR(4000) NULL,
    [PluginCallCount] NVARCHAR(4000) NULL,
    [PluginSuccessCount] NVARCHAR(4000) NULL,
    [TopicsStarted] NVARCHAR(4000) NULL,
    [TopicsCompleted] NVARCHAR(4000) NULL,
    [TopicCompletionRate] NVARCHAR(4000) NULL,
    [PrimaryTopicDwellMs] NVARCHAR(4000) NULL,
    [TotalTopicDwellMs] NVARCHAR(4000) NULL,
    [source_environment] NVARCHAR(4000) NULL,
    [transcript_date] DATE NULL
);
GO

IF OBJECT_ID(N'dbo.agent_catalogue', N'U') IS NULL
CREATE TABLE dbo.agent_catalogue (
    [agent_schema] NVARCHAR(4000) NULL,
    [agent_display_name] NVARCHAR(4000) NULL,
    [agent_class] NVARCHAR(4000) NULL,
    [source_environments] NVARCHAR(4000) NULL
);
GO

IF OBJECT_ID(N'dbo.evaluator_status', N'U') IS NULL
CREATE TABLE dbo.evaluator_status (
    [RunAt] DATETIME2(6) NULL,
    [Environment] NVARCHAR(4000) NULL,
    [EnvironmentUrl] NVARCHAR(4000) NULL,
    [LookbackDays] BIGINT NULL,
    [Transcripts] BIGINT NULL,
    [Status] NVARCHAR(4000) NULL,
    [Reason] NVARCHAR(4000) NULL
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'cix_agent_sessions' AND object_id = OBJECT_ID(N'dbo.agent_sessions'))
CREATE CLUSTERED INDEX cix_agent_sessions ON dbo.agent_sessions ([transcript_date]);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'cix_agent_turns' AND object_id = OBJECT_ID(N'dbo.agent_turns'))
CREATE CLUSTERED INDEX cix_agent_turns ON dbo.agent_turns ([transcript_date]);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'cix_agent_errors' AND object_id = OBJECT_ID(N'dbo.agent_errors'))
CREATE CLUSTERED INDEX cix_agent_errors ON dbo.agent_errors ([transcript_date]);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'cix_agent_subagents' AND object_id = OBJECT_ID(N'dbo.agent_subagents'))
CREATE CLUSTERED INDEX cix_agent_subagents ON dbo.agent_subagents ([transcript_date]);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'cix_agent_performance' AND object_id = OBJECT_ID(N'dbo.agent_performance'))
CREATE CLUSTERED INDEX cix_agent_performance ON dbo.agent_performance ([transcript_date]);
GO

IF NOT EXISTS (SELECT 1 FROM dbo.schema_version WHERE version = 8)
INSERT dbo.schema_version (version, description) VALUES (8, N'agentEvaluator: Agent Evaluator transcript tables');
GO
