// Container Apps environment (consumption), the scheduled run job, the manual migrate
// job and the Analytics Hub web app. Images are public on GHCR unless registryServer names a
// private registry, which is then pulled from with the managed identity.
param location string
param tags object
param environmentName string
param runJobName string
param migrateJobName string
param webName string
param deployWeb bool
param logAnalyticsName string
param identityId string
param identityClientId string
param jobsImage string
param webImage string
param runSchedule string
param runSteps string
param sampleData bool = false
param storageAccountName string
param sqlServerFqdn string
param sqlDatabaseName string
param webMinReplicas int = 0
param webClientId string = ''
param webAppIdUri string = ''
param reportingCurrency string = 'USD'
param exchangeRate string = ''
param webAccess string = ''
param version string
param modules string
param auditHistoryDays int
param powerBiWorkspaceId string
param semanticModels string
param sqlReaderName string
param sqlReaderClientId string = ''
param azureAiSubscriptionId string = ''
param paygSubscriptionIds string = ''
param dropSiteId string = ''
param dropDriveId string = ''
param dropFolder string = ''
param argManagementGroup string = ''
param argAgents bool = true
param argFoundry bool = true
param workdayOutputTable string = 'dbo.copilot_org_data_workday_preview'
param workdayAllowBaseOverwrite bool = false
param registryServer string = ''
@description('Subnet delegated to Microsoft.App/environments (private networking). Empty = no VNet.')
param infrastructureSubnetId string = ''
@description('Send logs through a diagnostic setting (azure-monitor) instead of the workspace\'s public ingestion endpoint and shared key. Used in private networking.')
param logsViaDiagnosticSettings bool = false

@description('Ask: the Azure OpenAI endpoint and deployment the web app answers questions with. Empty = Ask runs in the data agent or not at all.')
param askEndpoint string = ''
param askDeployment string = ''

@description('Agent Evaluator: the Dataverse environments the jobs read Copilot Studio transcripts from, as a JSON list of {url, name}.')
param dataverseEnvironments string = '[]'

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: logAnalyticsName
}

resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: environmentName
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: logsViaDiagnosticSettings ? { destination: 'azure-monitor' } : {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
    // Private mode: jobs reach SQL and Storage through private endpoints; web ingress stays public.
    vnetConfiguration: empty(infrastructureSubnetId) ? null : { infrastructureSubnetId: infrastructureSubnetId, internal: false }
  }
}

// Diagnostic settings deliver over Azure's own channel, so they work with public ingestion off.
// Logs land in ContainerAppConsoleLogs and ContainerAppSystemLogs (not the _CL tables).
resource envLogs 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (logsViaDiagnosticSettings) {
  scope: env
  name: 'logs'
  properties: {
    workspaceId: logs.id
    logs: [{ categoryGroup: 'allLogs', enabled: true }]
  }
}

var commonEnv = [
  { name: 'AZURE_CLIENT_ID', value: identityClientId }
  { name: 'VALUELENS_STORAGE_ACCOUNT', value: storageAccountName }
  { name: 'VALUELENS_SQL_SERVER', value: sqlServerFqdn }
  { name: 'VALUELENS_SQL_DATABASE', value: sqlDatabaseName }
  { name: 'VALUELENS_TENANT_ID', value: subscription().tenantId }
  { name: 'VALUELENS_VERSION', value: version }
  { name: 'VALUELENS_POWERBI_WORKSPACE_ID', value: powerBiWorkspaceId }
  { name: 'VALUELENS_SEMANTIC_MODELS', value: semanticModels }
  // The jobs load these modules; the web app tells the app which are off, so it skips their checks.
  { name: 'VALUELENS_MODULES', value: modules }
]
var jobEnv = concat(commonEnv, [
  { name: 'VALUELENS_AUDIT_HISTORY_DAYS', value: string(auditHistoryDays) }
  { name: 'VALUELENS_SQL_READER_NAME', value: sqlReaderName }
  { name: 'VALUELENS_SQL_READER_CLIENT_ID', value: sqlReaderClientId }
  { name: 'VALUELENS_SAMPLE_DATA', value: sampleData ? 'true' : 'false' }
  { name: 'VALUELENS_AZURE_AI_SUBSCRIPTION', value: azureAiSubscriptionId }
  { name: 'VALUELENS_PAYG_SUBSCRIPTIONS', value: paygSubscriptionIds }
  { name: 'VALUELENS_DROP_SITE_ID', value: dropSiteId }
  { name: 'VALUELENS_DROP_DRIVE_ID', value: dropDriveId }
  { name: 'VALUELENS_DROP_FOLDER', value: dropFolder }
  { name: 'VALUELENS_DATAVERSE_ENVIRONMENTS', value: dataverseEnvironments }
  { name: 'VALUELENS_ARG_MANAGEMENT_GROUP', value: argManagementGroup }
  { name: 'VALUELENS_ARG_AGENTS', value: argAgents ? 'true' : 'false' }
  { name: 'VALUELENS_ARG_FOUNDRY', value: argFoundry ? 'true' : 'false' }
  { name: 'VALUELENS_WORKDAY_OUTPUT_TABLE', value: workdayOutputTable }
  { name: 'VALUELENS_WORKDAY_ALLOW_BASE_OVERWRITE', value: workdayAllowBaseOverwrite ? 'true' : 'false' }
])
// `process` caps DuckDB at 5 of the run job's 8 GiB: some DuckDB memory sits outside the cap, and its
// default (80%) left under 1 GiB spare at 20,000 people. Change both together (azure/DESIGN.md, risks).
var runJobEnv = concat(jobEnv, [
  { name: 'VALUELENS_DUCKDB_MEMORY_LIMIT', value: '5GiB' }
])
var registries = empty(registryServer) ? [] : [{ server: registryServer, identity: identityId }]
var identity = {
  type: 'UserAssigned'
  userAssignedIdentities: { '${identityId}': {} }
}

resource runJob 'Microsoft.App/jobs@2024-03-01' = {
  name: runJobName
  location: location
  tags: tags
  identity: identity
  properties: {
    environmentId: env.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Schedule'
      registries: registries
      replicaTimeout: 14400
      replicaRetryLimit: 1
      scheduleTriggerConfig: { cronExpression: runSchedule, parallelism: 1, replicaCompletionCount: 1 }
    }
    template: {
      containers: [{
        name: 'run'
        image: jobsImage
        args: ['run', '--steps', runSteps]
        env: runJobEnv
        resources: { cpu: json('4'), memory: '8Gi' }
      }]
    }
  }
}

resource migrateJob 'Microsoft.App/jobs@2024-03-01' = {
  name: migrateJobName
  location: location
  tags: tags
  identity: identity
  properties: {
    environmentId: env.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Manual'
      registries: registries
      replicaTimeout: 1800
      replicaRetryLimit: 0
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
    }
    template: {
      containers: [{
        name: 'migrate'
        image: jobsImage
        args: ['migrate']
        env: jobEnv
        resources: { cpu: json('0.5'), memory: '1Gi' }
      }]
    }
  }
}

resource web 'Microsoft.App/containerApps@2024-03-01' = if (deployWeb) {
  name: webName
  location: location
  tags: tags
  identity: identity
  properties: {
    environmentId: env.id
    workloadProfileName: 'Consumption'
    configuration: {
      ingress: { external: true, targetPort: 8080, transport: 'auto', allowInsecure: false }
      registries: registries
    }
    template: {
      containers: [{
        name: 'web'
        image: webImage
        env: concat(commonEnv, [
          { name: 'VALUELENS_WEB_CLIENT_ID', value: webClientId }
          { name: 'VALUELENS_APP_ID_URI', value: webAppIdUri }
          { name: 'VALUELENS_CURRENCY', value: reportingCurrency }
          { name: 'VALUELENS_EXCHANGE_RATE', value: exchangeRate }
          { name: 'VALUELENS_ACCESS', value: webAccess }
          { name: 'VALUELENS_ASK_ENDPOINT', value: askEndpoint }
          { name: 'VALUELENS_ASK_DEPLOYMENT', value: askDeployment }
        ])
        resources: { cpu: json('0.5'), memory: '1Gi' }
        probes: [{ type: 'Liveness', httpGet: { path: '/api/health', port: 8080 } }]
      }]
      scale: { minReplicas: webMinReplicas, maxReplicas: 3 }
    }
  }
}

output environmentId string = env.id
output webUrl string = deployWeb ? 'https://${web!.properties.configuration.ingress.fqdn}' : ''
output webFqdn string = deployWeb ? web!.properties.configuration.ingress.fqdn : ''
