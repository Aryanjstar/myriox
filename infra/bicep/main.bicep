// Myriox core infrastructure: ACR, Container Apps environment, Cosmos DB (NoSQL + vector search),
// Blob Storage, Key Vault, and Azure OpenAI (GPT-4o + GPT-4o-mini + text-embedding-3-large).
@description('Base name used to derive resource names. Must be globally-unique-friendly (lowercase, no special chars).')
param baseName string = 'myrioxdev'

@description('Azure region for all resources.')
param location string = resourceGroup().location

@description('Azure OpenAI SKU tier.')
param openAiSku string = 'S0'

var acrName = '${baseName}acr'
var lawName = '${baseName}-law'
var caeName = '${baseName}-cae'
var cosmosName = '${baseName}-cosmos'
var storageName = '${baseName}sa'
var kvName = '${baseName}-kv'
var openAiName = '${baseName}-aoai'

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: acrName
  location: location
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: true
  }
}

resource law 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: lawName
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

resource cae 'Microsoft.App/managedEnvironments@2023-05-01' = {
  name: caeName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: law.properties.customerId
        sharedKey: law.listKeys().primarySharedKey
      }
    }
  }
}

resource cosmos 'Microsoft.DocumentDB/databaseAccounts@2024-05-15' = {
  name: cosmosName
  location: location
  kind: 'GlobalDocumentDB'
  properties: {
    databaseAccountOfferType: 'Standard'
    locations: [
      {
        locationName: location
        failoverPriority: 0
      }
    ]
    capabilities: [
      {
        name: 'EnableServerless'
      }
      {
        name: 'EnableNoSQLVectorSearch'
      }
    ]
    consistencyPolicy: {
      defaultConsistencyLevel: 'Session'
    }
  }
}

resource cosmosDb 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-05-15' = {
  parent: cosmos
  name: 'myriox'
  properties: {
    resource: {
      id: 'myriox'
    }
  }
}

resource containerPlans 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-05-15' = {
  parent: cosmosDb
  name: 'plans'
  properties: {
    resource: {
      id: 'plans'
      partitionKey: {
        paths: ['/orgId']
        kind: 'Hash'
      }
    }
  }
}

// Partitioned by /email (not /orgId): login only knows the email up front, and the
// document id IS the normalized email, so a login is always a single-partition point read.
resource containerUsers 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-05-15' = {
  parent: cosmosDb
  name: 'users'
  properties: {
    resource: {
      id: 'users'
      partitionKey: {
        paths: ['/email']
        kind: 'Hash'
      }
    }
  }
}

resource containerRuns 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-05-15' = {
  parent: cosmosDb
  name: 'runs'
  properties: {
    resource: {
      id: 'runs'
      partitionKey: {
        paths: ['/orgId']
        kind: 'Hash'
      }
    }
  }
}

resource containerAgentEvents 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-05-15' = {
  parent: cosmosDb
  name: 'agentEvents'
  properties: {
    resource: {
      id: 'agentEvents'
      partitionKey: {
        paths: ['/orgId']
        kind: 'Hash'
      }
      defaultTtl: 2592000
    }
  }
}

resource containerCodeClauses 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-05-15' = {
  parent: cosmosDb
  name: 'codeClauses'
  properties: {
    resource: {
      id: 'codeClauses'
      partitionKey: {
        paths: ['/jurisdiction']
        kind: 'Hash'
      }
      indexingPolicy: {
        indexingMode: 'consistent'
        includedPaths: [
          {
            path: '/*'
          }
        ]
        vectorIndexes: [
          {
            path: '/embedding'
            type: 'quantizedFlat'
          }
        ]
        excludedPaths: [
          {
            path: '/embedding/*'
          }
        ]
      }
      vectorEmbeddingPolicy: {
        vectorEmbeddings: [
          {
            path: '/embedding'
            dataType: 'float32'
            dimensions: 3072
            distanceFunction: 'cosine'
          }
        ]
      }
    }
  }
}

resource storage 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: storageName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-01-01' = {
  parent: storage
  name: 'default'
}

resource plansContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = {
  parent: blobService
  name: 'plans'
  properties: {
    publicAccess: 'None'
  }
}

resource kv 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: kvName
  location: location
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true
    accessPolicies: []
  }
}

resource openAi 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: openAiName
  location: location
  kind: 'OpenAI'
  sku: {
    name: openAiSku
  }
  properties: {
    customSubDomainName: openAiName
    publicNetworkAccess: 'Enabled'
  }
}

// Deployment names are stable aliases the app code references; the underlying model
// version is bumped here as Azure OpenAI's catalog evolves without touching app config.
resource agentReasoningModel 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: openAi
  name: 'agent-reasoning'
  sku: {
    name: 'GlobalStandard'
    // Raised from 20: per-tick agent reasoning fans out one call per active agent
    // concurrently, and 20 units of GlobalStandard TPM was throttling under that
    // concurrency, adding many seconds of retry latency to every tick.
    capacity: 150
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: 'gpt-5.4-mini'
      version: '2026-03-17'
    }
  }
}

resource reportSynthesisModel 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: openAi
  name: 'report-synthesis'
  sku: {
    name: 'GlobalStandard'
    capacity: 50
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: 'gpt-5.4'
      version: '2026-03-05'
    }
  }
  dependsOn: [
    agentReasoningModel
  ]
}

resource embeddings 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: openAi
  name: 'text-embedding-3-large'
  sku: {
    name: 'Standard'
    capacity: 100
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: 'text-embedding-3-large'
      version: '1'
    }
  }
  dependsOn: [
    reportSynthesisModel
  ]
}

output acrLoginServer string = acr.properties.loginServer
output containerAppsEnvironmentId string = cae.id
output cosmosEndpoint string = cosmos.properties.documentEndpoint
output storageAccountName string = storage.name
output keyVaultUri string = kv.properties.vaultUri
output openAiEndpoint string = openAi.properties.endpoint
