# Test ChatLofi Notification Server APIs

Write-Host "🧪 ChatLofi Notification Server - API Test Script" -ForegroundColor Cyan
Write-Host ""

$baseUrl = "http://localhost:3000"

# Function to test endpoint
function Test-Endpoint {
    param(
        [string]$Method,
        [string]$Endpoint,
        [string]$Description,
        [hashtable]$Body = $null
    )
    
    Write-Host "Testing: $Description" -ForegroundColor Yellow
    Write-Host "  → $Method $Endpoint" -ForegroundColor Gray
    
    try {
        if ($Body) {
            $jsonBody = $Body | ConvertTo-Json
            $response = Invoke-WebRequest -Uri "$baseUrl$Endpoint" `
                -Method $Method `
                -Body $jsonBody `
                -ContentType "application/json" `
                -ErrorAction Stop
        } else {
            $response = Invoke-WebRequest -Uri "$baseUrl$Endpoint" `
                -Method $Method `
                -ErrorAction Stop
        }
        
        Write-Host "  ✅ Success ($($response.StatusCode))" -ForegroundColor Green
        $response.Content | ConvertFrom-Json | ConvertTo-Json -Depth 5
        Write-Host ""
    }
    catch {
        Write-Host "  ❌ Error: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host ""
    }
}

# 1. Health Check
Test-Endpoint -Method "GET" -Endpoint "/" -Description "Service Info"
Test-Endpoint -Method "GET" -Endpoint "/health" -Description "Health Check"

# 2. Test Send Notification (Update USER_ID before running)
Write-Host "⚠️  Update USER_ID in script before testing notification endpoints" -ForegroundColor Magenta
Write-Host ""

$testUserId = "USER_ID_HERE"  # 👈 Thay bằng user ID thực từ Firestore

if ($testUserId -ne "USER_ID_HERE") {
    # Test send notification
    Test-Endpoint -Method "POST" -Endpoint "/api/send-notification" `
        -Description "Send Test Notification" `
        -Body @{
            recipientId = $testUserId
            title = "🧪 Test Notification"
            body = "This is a test from PowerShell script"
            data = @{
                screen = "Home"
                type = "test"
            }
        }
    
    # Test message notification
    Test-Endpoint -Method "POST" -Endpoint "/api/notify/message" `
        -Description "Send Message Notification" `
        -Body @{
            chatId = "test_chat_123"
            senderId = "sender_123"
            senderName = "Test Sender"
            text = "Hello from test!"
        }
    
    # Test friend request
    Test-Endpoint -Method "POST" -Endpoint "/api/notify/friend-request" `
        -Description "Send Friend Request Notification" `
        -Body @{
            recipientId = $testUserId
            senderId = "sender_123"
            senderName = "Test User"
        }
}

Write-Host "✨ Testing Complete!" -ForegroundColor Cyan
