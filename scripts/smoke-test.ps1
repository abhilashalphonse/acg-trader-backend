param(
  [string]$BaseUrl = "http://localhost:4000",
  [string]$ClientId = "acg-funded-backend"
)

$ErrorActionPreference = "Stop"

$apiKey = $env:ACG_TRADER_API_KEY
if (-not $apiKey) {
  throw "Set `$env:ACG_TRADER_API_KEY before running this script."
}

$headers = @{
  Authorization = "Bearer $apiKey"
  "x-acg-client-id" = $ClientId
}

Write-Host "TEST 1 — Provision demo account" -ForegroundColor Cyan

$externalRef = "smoke-demo-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
$ownerExternalRef = "smoke-user-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"

$provisionBody = @{
  externalRef      = $externalRef
  ownerExternalRef = $ownerExternalRef
  accountType      = "DEMO"
  currency         = "USD"
  leverage         = 100
  initialBalance   = "100000"
  riskTimezone     = "UTC"
  riskPolicy       = @{
    dailyLoss = @{
      limit = "3000"
      reference = "DAILY_START_EQUITY"
    }
    maxLoss = @{
      limit = "6000"
      reference = "INITIAL_BALANCE"
    }
    profitTarget = "10000"
    breachAction = "LIQUIDATE_AND_LOCK"
    allowedSymbols = @("EURUSD", "XAUUSD")
  }
} | ConvertTo-Json -Depth 10

$provision = Invoke-RestMethod `
  -Method POST `
  -Uri "$BaseUrl/v1/internal/trading/accounts/provision" `
  -Headers $headers `
  -ContentType "application/json" `
  -Body $provisionBody

$accountId = $provision.account.id
if (-not $accountId) {
  throw "TEST 1 FAILED: no account id returned"
}
Write-Host "TEST 1 PASSED — Account ID: $accountId" -ForegroundColor Green

Write-Host "TEST 2 — Native credential and login" -ForegroundColor Cyan

$credential = Invoke-RestMethod `
  -Method POST `
  -Uri "$BaseUrl/v1/internal/auth/accounts/$accountId/credentials" `
  -Headers $headers `
  -ContentType "application/json" `
  -Body '{}'

$login = $credential.credential.login
$password = $credential.temporaryPassword
if (-not $login -or -not $password) {
  throw "TEST 2A FAILED: login/password not returned"
}

$loginBody = @{
  tenant   = "acg-funded"
  login    = $login
  password = $password
} | ConvertTo-Json

$nativeSession = Invoke-RestMethod `
  -Method POST `
  -Uri "$BaseUrl/v1/auth/login" `
  -ContentType "application/json" `
  -Body $loginBody

if (
  -not $nativeSession.accessToken -or
  $nativeSession.session.authMethod -ne "PASSWORD" -or
  $nativeSession.session.accountIds -notcontains $accountId
) {
  throw "TEST 2 FAILED: native session is invalid"
}
Write-Host "TEST 2 PASSED — Native Trader login works" -ForegroundColor Green

Write-Host "TEST 3 — Federated ticket and exchange" -ForegroundColor Cyan

$ticketBody = @{
  ownerExternalRef = $ownerExternalRef
  accountIds       = @($accountId)
  metadata         = @{
    source = "acg-funded-smoke-test"
  }
} | ConvertTo-Json -Depth 10

$ticketResult = Invoke-RestMethod `
  -Method POST `
  -Uri "$BaseUrl/v1/internal/auth/federation/tickets" `
  -Headers $headers `
  -ContentType "application/json" `
  -Body $ticketBody

$ticket = $ticketResult.ticket
if (-not $ticket) {
  throw "TEST 3A FAILED: no federation ticket returned"
}

$exchangeBody = @{
  ticket = $ticket
} | ConvertTo-Json

$federatedSession = Invoke-RestMethod `
  -Method POST `
  -Uri "$BaseUrl/v1/auth/federated/exchange" `
  -ContentType "application/json" `
  -Body $exchangeBody

if (
  -not $federatedSession.accessToken -or
  $federatedSession.session.authMethod -ne "FEDERATED" -or
  $federatedSession.session.accountIds -notcontains $accountId
) {
  throw "TEST 3 FAILED: federated session is invalid"
}
Write-Host "TEST 3 PASSED — ACG Funded federated login works" -ForegroundColor Green

Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "ALL 3 SERVICE PATH TESTS PASSED" -ForegroundColor Green
Write-Host "Account: $accountId"
Write-Host "Native Login: $login"
Write-Host "==========================================" -ForegroundColor Cyan
