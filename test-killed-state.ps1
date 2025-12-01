# Test script for killed state notifications
# Run this AFTER killing the app completely

$serverUrl = "https://chatlofi-notification.onrender.com"
# $serverUrl = "http://localhost:3000"  # Uncomment for local testing

# IMPORTANT: Replace these with actual values from your Firebase/Firestore
$testRecipientId = "YOUR_USER_ID_HERE"  # The user who should receive notification
$testTitle = "Test Notification"
$testBody = "This is a test for killed state - $(Get-Date -Format 'HH:mm:ss')"

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "Testing Killed State Notification" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# 1. Check server health
Write-Host "1. Checking server health..." -ForegroundColor Yellow
try {
    $health = Invoke-RestMethod -Uri "$serverUrl/health" -Method Get
    Write-Host "   Server status: $($health.status)" -ForegroundColor Green
} catch {
    Write-Host "   ERROR: Server not reachable!" -ForegroundColor Red
    Write-Host "   Make sure you deployed the server to Render" -ForegroundColor Red
    Write-Host "   Error: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

Write-Host ""

# 2. Send test notification
Write-Host "2. Sending test notification..." -ForegroundColor Yellow
Write-Host "   Recipient ID: $testRecipientId" -ForegroundColor Gray
Write-Host "   Title: $testTitle" -ForegroundColor Gray
Write-Host "   Body: $testBody" -ForegroundColor Gray
Write-Host ""

$body = @{
    recipientId = $testRecipientId
    title = $testTitle
    body = $testBody
    data = @{
        type = "test"
        screen = "Chat_fr"
        timestamp = (Get-Date -Format "yyyy-MM-ddTHH:mm:ss")
    }
} | ConvertTo-Json -Depth 3

try {
    $response = Invoke-RestMethod -Uri "$serverUrl/api/send-notification" -Method Post -Body $body -ContentType "application/json"
    
    Write-Host "============================================" -ForegroundColor Green
    Write-Host "SUCCESS!" -ForegroundColor Green
    Write-Host "============================================" -ForegroundColor Green
    Write-Host "Response:" -ForegroundColor Gray
    $response | ConvertTo-Json -Depth 3 | Write-Host
    Write-Host ""
    Write-Host "If you killed the app and don't see notification:" -ForegroundColor Yellow
    Write-Host "1. Check phone Settings > Apps > ChatLofi > Notifications (enable all)" -ForegroundColor White
    Write-Host "2. Check phone Settings > Apps > ChatLofi > Battery > Unrestricted" -ForegroundColor White
    Write-Host "3. Make sure Do Not Disturb is OFF" -ForegroundColor White
    Write-Host "4. Some phones (Xiaomi, Huawei, Oppo) need Autostart permission" -ForegroundColor White
    
} catch {
    Write-Host "============================================" -ForegroundColor Red
    Write-Host "FAILED!" -ForegroundColor Red
    Write-Host "============================================" -ForegroundColor Red
    Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
    
    # Try to get more details
    if ($_.Exception.Response) {
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        $errorBody = $reader.ReadToEnd()
        Write-Host "Server response: $errorBody" -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "Troubleshooting Checklist:" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "[ ] Server deployed to Render with updated code" -ForegroundColor White
Write-Host "[ ] FIREBASE_SERVICE_ACCOUNT env var set on Render" -ForegroundColor White
Write-Host "[ ] User has FCM token in Firestore (users/{userId}/fcmToken)" -ForegroundColor White
Write-Host "[ ] App was rebuilt with new AndroidManifest.xml" -ForegroundColor White
Write-Host "[ ] Old app uninstalled, new APK installed" -ForegroundColor White
Write-Host "[ ] App opened at least once to register FCM token" -ForegroundColor White
Write-Host "[ ] Phone notifications enabled for ChatLofi" -ForegroundColor White
Write-Host "[ ] Battery optimization disabled for ChatLofi" -ForegroundColor White
