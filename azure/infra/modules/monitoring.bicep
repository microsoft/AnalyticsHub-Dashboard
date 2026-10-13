param location string
param name string
param tags object
@description('Disabled in private networking. Container Apps then sends logs through a diagnostic setting, which doesn\'t use public ingestion.')
@allowed(['Enabled', 'Disabled'])
param publicNetworkAccess string = 'Enabled'

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    features: { enableLogAccessUsingOnlyResourcePermissions: true }
    publicNetworkAccessForIngestion: publicNetworkAccess
    publicNetworkAccessForQuery: publicNetworkAccess
  }
}

output id string = logs.id
output name string = logs.name
