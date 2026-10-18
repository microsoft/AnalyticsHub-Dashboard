// Azure, by hand: docs/MANUAL-INSTALL.md#azure. The installer doesn't use this file.
// Copy it to my.bicepparam, and the steps fill it in. Keep it: it's your install's record.
using 'main.bicep'

param installId = 'by-hand' // Don't change it: the resource names come from it.
param imageTag = loadJsonContent('../../installer/package.json').version
param modules = 'core,orgData' // Add ,consumption for credit consumption.
param sqlReaderName = 'Analytics Hub SQL Reader' // The database user Power BI reads as.

// Step 1. Remove deletes the resource group in this subscription.
#disable-next-line no-unused-vars
var subscription = ''

// Step 2.
param webClientId = ''
param webAppIdUri = ''
param sqlReaderClientId = ''

// Step 4.
var workspace = ''
var model = ''
var consumptionModel = '' // Credit consumption only.

param powerBiWorkspaceId = workspace
param semanticModels = string(union(
  empty(model) ? {} : { vl: { workspaceId: workspace, itemId: model } },
  empty(consumptionModel) ? {} : { cc: { workspaceId: workspace, itemId: consumptionModel } }
))

// Extras: remove the // to use one, then redeploy.
// param sampleData = true
// param askMode = 'create'
// param auditHistoryDays = 90
// param runSchedule = '0 3 * * *'
// param sqlLocation = ''
// param sqlUseFreeLimit = true
// param azureAiSubscriptionId = ''
