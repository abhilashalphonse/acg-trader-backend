# ============================================================
# ACG TRADER — SERVICE PATH SMOKE TEST
# ============================================================

$baseUrl = "http://localhost:4000"
$clientId = "acg-funded-backend"

# Put your service key here LOCALLY.
# Do not paste it back into chat.
$apiKey = $env:ACG_TRADER_API_KEY

if (-not $apiKey) {
    throw "Set `$env:ACG_TRADER_API_KEY first."
}

$headers = @{
    Authorization   = "Bearer $apiKey"
    "x-acg-client-id" = $clientId
}

# ============================================================
# TEST 1 — PROVISION A $100K DEMO ACCOUNT
# ============================================================

$provisionBody = @{
    externalRef      = "smoke-demo-001"
    ownerExternalRef = "smoke-user-001"
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
    -Uri "$baseUrl/v1/internal/trading/accounts/provision" `
    -Headers $headers `
    -ContentType "application/json" `
    -Body $provisionBody

"TEST 1 — PROVISION"
$provision | ConvertTo-Json -Depth 10

$accountId = $provision.account.id

if (-not $accountId) {
    throw "TEST 1 FAILED: no account id returned"
}

Write-Host "TEST 1 PASSED — Account ID: $accountId" -ForegroundColor Green


# ============================================================
# TEST 2 — CREATE NATIVE CREDENTIAL + LOGIN
# ============================================================

$credential = Invoke-RestMethod `
    -Method POST `
    -Uri "$baseUrl/v1/internal/auth/accounts/$accountId/credentials" `
    -Headers $headers `
    -ContentType "application/json" `
    -Body '{}'

"TEST 2A — CREDENTIAL"
$credential | ConvertTo-Json -Depth 10

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
    -Uri "$baseUrl/v1/auth/login" `
    -ContentType "application/json" `
    -Body $loginBody

"TEST 2B — NATIVE LOGIN"
$nativeSession | ConvertTo-Json -Depth 10

if (
    -not $nativeSession.accessToken -or
    $nativeSession.session.authMethod -ne "PASSWORD" -or
    $nativeSession.session.accountIds -notcontains $accountId
) {
    throw "TEST 2 FAILED: native session is invalid"
}

Write-Host "TEST 2 PASSED — Native Trader login works" -ForegroundColor Green


# ============================================================
# TEST 3 — FEDERATED TICKET + EXCHANGE
# ============================================================

$ticketBody = @{
    ownerExternalRef = "smoke-user-001"
    accountIds       = @($accountId)
    metadata         = @{
        source = "acg-funded-smoke-test"
    }
} | ConvertTo-Json -Depth 10

$ticketResult = Invoke-RestMethod `
    -Method POST `
    -Uri "$baseUrl/v1/internal/auth/federation/tickets" `
    -Headers $headers `
    -ContentType "application/json" `
    -Body $ticketBody

"TEST 3A — FEDERATION TICKET"
$ticketResult | ConvertTo-Json -Depth 10

$ticket = $ticketResult.ticket

if (-not $ticket) {
    throw "TEST 3A FAILED: no federation ticket returned"
}

$exchangeBody = @{
    ticket = $ticket
} | ConvertTo-Json

$federatedSession = Invoke-RestMethod `
    -Method POST `
    -Uri "$baseUrl/v1/auth/federated/exchange" `
    -ContentType "application/json" `
    -Body $exchangeBody

"TEST 3B — FEDERATED EXCHANGE"
$federatedSession | ConvertTo-Json -Depth 10

if (
    -not $federatedSession.accessToken -or
    $federatedSession.session.authMethod -ne "FEDERATED" -or
    $federatedSession.session.accountIds -notcontains $accountId
) {
    throw "TEST 3 FAILED: federated session is invalid"
}

Write-Host "TEST 3 PASSED — ACG Funded federated login works" -ForegroundColor Green


# ============================================================
# FINAL
# ============================================================

Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "ALL 3 SERVICE PATH TESTS PASSED" -ForegroundColor Green
Write-Host "Account: $accountId"
Write-Host "Native Login: $login"
Write-Host "==========================================" -ForegroundColor Cyan