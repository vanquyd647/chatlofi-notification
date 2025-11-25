# 📡 ChatLofi Notification Server

Backend server để gửi push notifications sử dụng FCM HTTP v1 API. Deploy lên Render.com.

## 🚀 Deploy lên Render

### Bước 1: Tạo Web Service trên Render

1. Vào: https://render.com
2. Click "New +" → "Web Service"
3. Connect Git repository hoặc upload code

### Bước 2: Cấu hình Service

**Build Command:**
```bash
cd notification-server && npm install
```

**Start Command:**
```bash
cd notification-server && npm start
```

**Environment:**
- Runtime: Node
- Region: Singapore (hoặc gần nhất)
- Instance Type: Free (hoặc Starter nếu cần)

### Bước 3: Set Environment Variables

Trên Render Dashboard → Environment:

1. **PORT**: `3000` (Render tự động set, có thể bỏ qua)

2. **FIREBASE_SERVICE_ACCOUNT**: 
   - Mở file `config/service-account/service-account-key.json`
   - Copy toàn bộ nội dung (JSON)
   - Paste vào Environment Variable
   - Ví dụ:
   ```json
   {"type":"service_account","project_id":"chatlofi-9c2c8","private_key_id":"...","private_key":"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n","client_email":"...","client_id":"...","auth_uri":"...","token_uri":"...","auth_provider_x509_cert_url":"...","client_x509_cert_url":"..."}
   ```

### Bước 4: Deploy

Click "Create Web Service" → Render sẽ tự động build và deploy

**URL của bạn sẽ dạng:**
```
https://chatlofi-notification.onrender.com
```

---

## 🧪 Test API

### Health Check
```bash
curl https://chatlofi-notification.onrender.com/health
```

### Send Message Notification
```bash
curl -X POST https://chatlofi-notification.onrender.com/api/notify/message \
  -H "Content-Type: application/json" \
  -d '{
    "chatId": "chat123",
    "senderId": "user1",
    "senderName": "John",
    "text": "Hello!"
  }'
```

### Send Friend Request Notification
```bash
curl -X POST https://chatlofi-notification.onrender.com/api/notify/friend-request \
  -H "Content-Type: application/json" \
  -d '{
    "recipientId": "user2",
    "senderId": "user1",
    "senderName": "John"
  }'
```

### Send Custom Notification
```bash
curl -X POST https://chatlofi-notification.onrender.com/api/send-notification \
  -H "Content-Type: application/json" \
  -d '{
    "recipientId": "user123",
    "title": "Test",
    "body": "This is a test",
    "data": {"screen": "Home"}
  }'
```

---

## 📱 Tích hợp vào React Native App

Cập nhật `NotificationContext.js`:

```javascript
const NOTIFICATION_SERVER_URL = 'https://chatlofi-notification.onrender.com';

// Gửi notification khi có tin nhắn mới
const sendMessageNotification = async (chatId, senderId, senderName, text) => {
  try {
    const response = await fetch(`${NOTIFICATION_SERVER_URL}/api/notify/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chatId,
        senderId,
        senderName,
        text
      })
    });
    
    const result = await response.json();
    console.log('Notification sent:', result);
  } catch (error) {
    console.error('Error sending notification:', error);
  }
};

// Gửi notification khi có friend request
const sendFriendRequestNotification = async (recipientId, senderId, senderName) => {
  try {
    const response = await fetch(`${NOTIFICATION_SERVER_URL}/api/notify/friend-request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        recipientId,
        senderId,
        senderName
      })
    });
    
    const result = await response.json();
    console.log('Notification sent:', result);
  } catch (error) {
    console.error('Error sending notification:', error);
  }
};
```

---

## 🔧 Local Development

### Install dependencies
```bash
cd notification-server
npm install
```

### Set environment variables
```bash
# Copy .env.example to .env
cp .env.example .env

# Edit .env và thêm FIREBASE_SERVICE_ACCOUNT
```

### Run server
```bash
npm start

# Hoặc với nodemon (auto-reload)
npm run dev
```

Server chạy tại: http://localhost:3000

---

## 📊 API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Service info |
| `/health` | GET | Health check |
| `/api/send-notification` | POST | Gửi custom notification |
| `/api/notify/message` | POST | Gửi message notification |
| `/api/notify/friend-request` | POST | Gửi friend request notification |
| `/api/notify/new-post` | POST | Gửi new post notification |

---

## 💰 Chi phí Render

**Free Tier:**
- ✅ 750 giờ/tháng miễn phí
- ✅ Tự động sleep sau 15 phút không hoạt động
- ✅ Wake up khi có request (cold start ~30s)

**Starter Plan ($7/tháng):**
- ✅ Không sleep
- ✅ Response nhanh hơn
- ✅ Phù hợp cho production

**Khuyến nghị:** Bắt đầu với Free tier, upgrade khi cần.

---

## 🔒 Bảo mật

### Thêm API Key Authentication (Optional)

```javascript
// server.js - Thêm middleware
const authenticateApiKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  
  if (apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  next();
};

// Áp dụng cho tất cả routes
app.use('/api', authenticateApiKey);
```

Thêm vào Render Environment Variables:
```
API_KEY=your-secret-api-key-here
```

---

## 🛠️ Troubleshooting

### Server không start?
- Kiểm tra Render logs
- Verify FIREBASE_SERVICE_ACCOUNT đã set đúng format JSON

### Notification không gửi được?
- Kiểm tra FCM token có trong Firestore chưa
- Verify Firebase Cloud Messaging API đã bật
- Check Render logs để xem error

### Cold start chậm?
- Upgrade lên Starter plan ($7/tháng)
- Hoặc setup ping service để keep alive

---

**Ready to deploy!** 🚀
