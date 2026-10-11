# =====================================================================
# MultiMesh (Airlock) - Interactive Live Cloud AI Ops Terminal
# =====================================================================
Clear-Host
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "   MULTIMESH AIRLOCK :: ZERO-TRUST AI CLOUD OPS CLI (LIVE AWS)  " -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan

# --- 0. Credentials: from environment, else prompt (never hardcode) ---
$AwsAccessKey = $env:AWS_ACCESS_KEY_ID
if ([string]::IsNullOrWhiteSpace($AwsAccessKey)) {
    $AwsAccessKey = Read-Host "AWS Access Key ID"
}

$AwsSecretKey = $env:AWS_SECRET_ACCESS_KEY
if ([string]::IsNullOrWhiteSpace($AwsSecretKey)) {
    $SecureSecret = Read-Host "AWS Secret Access Key" -AsSecureString
    $AwsSecretKey = [System.Net.NetworkCredential]::new("", $SecureSecret).Password
}

$InstanceId = "i-036fd615d17317911"

# --- 1. Authenticate & Vault Credentials on Startup ---
$RunId = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$Email = "operator_$RunId@airlock.test"
$Pass  = "Password123!"

Write-Host "`n[*] Authenticating operator session on Airlock Gateway (:3000)..." -ForegroundColor DarkGray
$Reg = Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/auth/register" `
  -ContentType "application/json" `
  -Body (@{ email = $Email; password = $Pass } | ConvertTo-Json)

$Token = if ($Reg.token) { $Reg.token } else {
  (Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/auth/login" `
    -ContentType "application/json" `
    -Body (@{ email = $Email; password = $Pass } | ConvertTo-Json)).token
}

Write-Host "[*] Sealing AWS IAM credentials in AES-256-GCM Vault..." -ForegroundColor DarkGray
$EnvResp = Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/environments" `
  -Headers @{ Authorization = "Bearer $Token" } `
  -ContentType "application/json" `
  -Body (@{
    provider  = "AWS"
    alias     = "aws-prod-$RunId"
    accessKey = $AwsAccessKey
    secretKey = $AwsSecretKey
  } | ConvertTo-Json)

# Drop the plaintext secret from memory as soon as it is vaulted
Remove-Variable AwsSecretKey, SecureSecret -ErrorAction SilentlyContinue

$EnvId = if ($EnvResp.environment) { $EnvResp.environment.id } else { $EnvResp.id }

Write-Host "[+] Vault Ready! Environment ID : $EnvId" -ForegroundColor Green
Write-Host "[+] Default Target EC2 Instance : $InstanceId" -ForegroundColor Green
Write-Host "----------------------------------------------------------------" -ForegroundColor DarkGray
Write-Host "Type any natural language command (e.g. 'start instance', 'stop instance')" -ForegroundColor Gray
Write-Host "Type 'exit' to quit." -ForegroundColor Gray
Write-Host "----------------------------------------------------------------" -ForegroundColor DarkGray

# --- 2. Interactive Command Loop ---
while ($true) {
    Write-Host "`nAirlock-AI> " -NoNewline -ForegroundColor Cyan
    $UserPrompt = Read-Host

    if ([string]::IsNullOrWhiteSpace($UserPrompt)) { continue }
    if ($UserPrompt.Trim().ToLower() -eq "exit") {
        Write-Host "Closing Airlock session." -ForegroundColor Yellow
        break
    }

    # If no instance ID is typed, append the default target automatically.
    if ($UserPrompt -notmatch "i-[0-9a-f]{8,17}") {
        $FullPrompt = "$UserPrompt (Target EC2 instance ID: $InstanceId)"
    } else {
        $FullPrompt = $UserPrompt
    }

    Write-Host "`n[*] Dispatching to LangGraph Agent (:8000)..." -ForegroundColor DarkGray
    try {
        $InvokeResp = Invoke-RestMethod -Method Post -Uri "http://localhost:8000/invoke" `
          -ContentType "application/json" `
          -Body (@{
            prompt         = $FullPrompt
            environment_id = $EnvId
            user_token     = $Token
          } | ConvertTo-Json)
    } catch {
        Write-Host "[!] Error calling /invoke: $($_.Exception.Message)" -ForegroundColor Red
        continue
    }

    # Check if the graph paused at the Human-in-the-Loop gate
    if (-not $InvokeResp.interrupted) {
        Write-Host "`n[Agent]: $($InvokeResp.message)" -ForegroundColor Green
        continue
    }

    Write-Host "`n================================================================" -ForegroundColor Yellow
    Write-Host " [!] HUMAN-IN-THE-LOOP AIRLOCK INTERCEPT TRIGGERED" -ForegroundColor Yellow
    Write-Host "================================================================" -ForegroundColor Yellow
    Write-Host " Thread ID  : $($InvokeResp.thread_id)" -ForegroundColor White
    Write-Host " Action ID  : $($InvokeResp.action_id)" -ForegroundColor White
    Write-Host " Status     : $($InvokeResp.approval_status)" -ForegroundColor Yellow
    Write-Host "================================================================" -ForegroundColor Yellow

    Write-Host "Approve live AWS execution? [Y/N]: " -NoNewline -ForegroundColor Yellow
    $DecisionInput = Read-Host
    $ApprovalStatus = if ($DecisionInput.Trim().ToUpper() -eq "Y") { "APPROVED" } else { "REJECTED" }

    Write-Host "[*] Forwarding '$ApprovalStatus' decision to Airlock & MCP (:8001)..." -ForegroundColor DarkGray
    try {
        $ResumeResp = Invoke-RestMethod -Method Post -Uri "http://localhost:8000/resume/$($InvokeResp.thread_id)" `
          -ContentType "application/json" `
          -Body (@{
            approval_status = $ApprovalStatus
            user_token      = $Token
          } | ConvertTo-Json)

        Write-Host "`n[Agent]: $($ResumeResp.message)" -ForegroundColor Green

        if ($ApprovalStatus -eq "APPROVED") {
            $State = Invoke-RestMethod -Method Get -Uri "http://localhost:8000/state/$($InvokeResp.thread_id)"
            $ToolMsgs = @($State.values.messages | Where-Object { $_.type -eq "tool" })
            if ($ToolMsgs.Count -gt 0) {
                $LastTool = $ToolMsgs[-1]
                Write-Host "[MCP Live Telemetry]: $($LastTool.content)" -ForegroundColor Magenta
            }
        }
    } catch {
        Write-Host "[!] Error during /resume: $($_.Exception.Message)" -ForegroundColor Red
    }
}