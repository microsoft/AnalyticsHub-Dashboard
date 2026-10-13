// Private networking with existing private DNS zones (privateDnsZoneMode = existing): links the
// VNet to zones that live in another resource group, often a hub's in an Azure Landing Zone.
// Deployed into that resource group, so the installer needs Private DNS Zone Contributor there.
param zoneNames array
param vnetId string
param linkName string
param tags object

resource zones 'Microsoft.Network/privateDnsZones@2024-06-01' existing = [for z in zoneNames: {
  name: z
}]

resource links 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = [for (z, i) in zoneNames: {
  parent: zones[i]
  name: linkName
  location: 'global'
  tags: tags
  properties: { registrationEnabled: false, virtualNetwork: { id: vnetId } }
}]
