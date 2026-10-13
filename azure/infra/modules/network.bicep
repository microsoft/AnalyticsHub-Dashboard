// Private networking mode (publicNetworkAccess = Disabled): a VNet for the Container Apps
// environment, private endpoints with private DNS for SQL, Storage and (when created here) the
// Ask AI Services account, and a subnet delegated to Power Platform so a Power BI VNet data
// gateway can refresh the model from SQL.
// Private endpoints may sit in a different region from their target (Azure SQL can be moved
// to another region for capacity), so everything here uses the VNet's location.
param location string
param tags object
param vnetName string
param addressPrefix string
param sqlServerId string
param storageAccountId string
@description('Ask AI Services account to reach privately. Empty = none.')
param askAccountId string = ''
@description('create: private DNS zones in this resource group, linked to the VNet. existing: zones already in privateDnsZonesResourceGroupId (main.bicep links the VNet to them). none: no zones, links or zone groups (Azure Policy or the network team adds them).')
@allowed(['create', 'existing', 'none'])
param privateDnsZoneMode string = 'create'
param privateDnsZonesResourceGroupId string = ''

var subnets = {
  apps: cidrSubnet(addressPrefix, 23, 0)
  endpoints: cidrSubnet(addressPrefix, 24, 2)
  gateway: cidrSubnet(addressPrefix, 27, 24)
}

// Policies commonly require an NSG on every subnet. The default rules already allow VNet and
// load balancer traffic and outbound internet; the web app's public ingress needs 80/443 in.
resource nsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: 'nsg-${vnetName}'
  location: location
  tags: tags
  properties: {
    securityRules: [
      {
        name: 'allow-web-ingress'
        properties: {
          priority: 100
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: 'Internet'
          sourcePortRange: '*'
          destinationAddressPrefix: subnets.apps
          destinationPortRanges: ['80', '443']
        }
      }
    ]
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: vnetName
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: [addressPrefix] }
    subnets: [
      {
        name: 'snet-apps'
        properties: {
          addressPrefix: subnets.apps
          networkSecurityGroup: { id: nsg.id }
          delegations: [{ name: 'containerapps', properties: { serviceName: 'Microsoft.App/environments' } }]
        }
      }
      {
        name: 'snet-endpoints'
        properties: {
          addressPrefix: subnets.endpoints
          networkSecurityGroup: { id: nsg.id }
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
      {
        name: 'snet-powerbi-gateway'
        properties: {
          addressPrefix: subnets.gateway
          networkSecurityGroup: { id: nsg.id }
          delegations: [{ name: 'powerplatform', properties: { serviceName: 'Microsoft.PowerPlatform/vnetaccesslinks' } }]
        }
      }
    ]
  }
}

var sqlZone = 'privatelink${environment().suffixes.sqlServerHostname}'
var blobZone = 'privatelink.blob.${environment().suffixes.storage}'
var dfsZone = 'privatelink.dfs.${environment().suffixes.storage}'
var tableZone = 'privatelink.table.${environment().suffixes.storage}'
var aiZones = ['privatelink.cognitiveservices.azure.com', 'privatelink.openai.azure.com', 'privatelink.services.ai.azure.com']
var endpoints = concat([
  { name: 'sql', target: sqlServerId, group: 'sqlServer', zones: [sqlZone] }
  { name: 'blob', target: storageAccountId, group: 'blob', zones: [blobZone] }
  { name: 'dfs', target: storageAccountId, group: 'dfs', zones: [dfsZone] }
  { name: 'table', target: storageAccountId, group: 'table', zones: [tableZone] }
], empty(askAccountId) ? [] : [{ name: 'ai', target: askAccountId, group: 'account', zones: aiZones }])
var zoneNames = concat([sqlZone, blobZone, dfsZone, tableZone], empty(askAccountId) ? [] : aiZones)
var zoneResourceGroupId = privateDnsZoneMode == 'existing' && !empty(privateDnsZonesResourceGroupId) ? privateDnsZonesResourceGroupId : resourceGroup().id

resource zones 'Microsoft.Network/privateDnsZones@2024-06-01' = [for z in zoneNames: if (privateDnsZoneMode == 'create') {
  name: z
  location: 'global'
  tags: tags
}]

resource links 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = [for (z, i) in zoneNames: if (privateDnsZoneMode == 'create') {
  parent: zones[i]
  name: vnetName
  location: 'global'
  tags: tags
  properties: { registrationEnabled: false, virtualNetwork: { id: vnet.id } }
}]

resource privateEndpoints 'Microsoft.Network/privateEndpoints@2024-05-01' = [for e in endpoints: {
  name: 'pe-${last(split(e.target, '/'))}-${e.name}'
  location: location
  tags: tags
  properties: {
    subnet: { id: '${vnet.id}/subnets/snet-endpoints' }
    privateLinkServiceConnections: [{
      name: e.name
      properties: { privateLinkServiceId: e.target, groupIds: [e.group] }
    }]
  }
}]

resource dnsGroups 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = [for (e, i) in endpoints: if (privateDnsZoneMode != 'none') {
  parent: privateEndpoints[i]
  name: 'default'
  dependsOn: [zones]
  properties: {
    privateDnsZoneConfigs: [for (z, j) in e.zones: {
      name: j == 0 ? e.name : '${e.name}-${j}'
      properties: { privateDnsZoneId: '${zoneResourceGroupId}/providers/Microsoft.Network/privateDnsZones/${z}' }
    }]
  }
}]

output vnetId string = vnet.id
output vnetName string = vnet.name
output appsSubnetId string = '${vnet.id}/subnets/snet-apps'
output gatewaySubnetName string = 'snet-powerbi-gateway'
output zoneNames array = zoneNames
