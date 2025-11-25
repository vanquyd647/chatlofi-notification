# Firebase Configuration Guide - ChatLofi Notification Server

## 🔥 Firebase Project Information

**Project ID:** `chatlofi-9c2c8`  
**Project Name:** ChatLofi

### Firebase Client Configuration (Web App)
```javascript
const firebaseConfig = {
  apiKey: "AIzaSyB56q0rIYvt9KbDVFkqysdDKeq6HunrBkA",
  authDomain: "chatlofi-9c2c8.firebaseapp.com",
  projectId: "chatlofi-9c2c8",
  storageBucket: "chatlofi-9c2c8.appspot.com",
  messagingSenderId: "901109384021",
  appId: "1:901109384021:web:e8c72a03840424509625dc",
  measurementId: "G-L0TG3RV89H"
};
```

---

## 📋 Các bước cấu hình

### Bước 1: Lấy Service Account Key (Firebase Admin SDK)

1. Truy cập [Firebase Console](https://console.firebase.google.com/)
2. Chọn project **chatlofi-9c2c8**
3. Vào **Project Settings** (⚙️ icon)
4. Chọn tab **Service Accounts**
5. Click **Generate new private key**
6. Download file JSON (ví dụ: `service-account-key.json`)

⚠️ **LƯU Ý:** File này chứa private key, KHÔNG public lên Git!

### Bước 2: Cấu hình Local Development

#### Option 1: Sử dụng Environment Variable

1. Copy `.env.example` thành `.env`:
```powershell
Copy-Item .env.example .env
```

2. Mở file `service-account-key.json` vừa download
3. Copy **toàn bộ** nội dung JSON
4. Paste vào biến `FIREBASE_SERVICE_ACCOUNT` trong file `.env` (1 dòng duy nhất)

```env
FIREBASE_SERVICE_ACCOUNT={"type":"service_account","project_id":"chatlofi-9c2c8","private_key_id":"abc123...","private_key":"-----BEGIN PRIVATE KEY-----\n...","client_email":"firebase-adminsdk-xxx@chatlofi-9c2c8.iam.gserviceaccount.com","client_id":"...","auth_uri":"https://accounts.google.com/o/oauth2/auth","token_uri":"https://oauth2.googleapis.com/token","auth_provider_x509_cert_url":"https://www.googleapis.com/oauth2/v1/certs","client_x509_cert_url":"..."}
```

#### Option 2: Sử dụng File Path (Khuyến nghị cho local)

1. Tạo thư mục config:
```powershell
New-Item -ItemType Directory -Force -Path config
```

2. Move file service account vào đó:
```powershell
Move-Item service-account-key.json config/
```

3. Cập nhật `.env`:
```env
GOOGLE_APPLICATION_CREDENTIALS=./config/service-account-key.json
```

4. Thêm vào `.gitignore`:
```
config/
.env
```

### Bước 3: Cấu hình trên Render (Production)

1. Vào Render Dashboard
2. Chọn service **notification-server**
3. Vào **Environment** tab
4. Thêm Environment Variable:

**KEY:** `FIREBASE_SERVICE_ACCOUNT`  
**VALUE:** Paste toàn bộ nội dung file `service-account-key.json` (minify thành 1 dòng)

Các biến khác (tùy chọn):
```
FIREBASE_PROJECT_ID=chatlofi-9c2c8
```

---

## 🧪 Test API

### 1. Chạy server local
```powershell
npm install
npm run dev
```

### 2. Test health check
```powershell
Invoke-WebRequest -Uri http://localhost:3000/health
```

### 3. Test gửi thông báo

**Yêu cầu:** User phải có `fcmToken` trong Firestore collection `users`

```powershell
$body = @{
    recipientId = "USER_ID_HERE"
    title = "Test Notification"
    body = "This is a test message from notification server"
    data = @{
        screen = "Home"
        type = "test"
    }
} | ConvertTo-Json

Invoke-WebRequest -Uri http://localhost:3000/api/send-notification `
    -Method POST `
    -Body $body `
    -ContentType "application/json"
```

---

## 📱 Client App Configuration

### React Native / Expo

1. Install Firebase dependencies:
```bash
npm install @react-native-firebase/app @react-native-firebase/messaging
# hoặc
expo install expo-notifications firebase
```

2. Initialize Firebase trong app:
```javascript
import { initializeApp } from 'firebase/app';
import { getMessaging, getToken } from 'firebase/messaging';

const firebaseConfig = {
  apiKey: "AIzaSyB56q0rIYvt9KbDVFkqysdDKeq6HunrBkA",
  authDomain: "chatlofi-9c2c8.firebaseapp.com",
  projectId: "chatlofi-9c2c8",
  storageBucket: "chatlofi-9c2c8.appspot.com",
  messagingSenderId: "901109384021",
  appId: "1:901109384021:web:e8c72a03840424509625dc",
  measurementId: "G-L0TG3RV89H"
};

const app = initializeApp(firebaseConfig);
```

3. Request permission và lấy FCM token:
```javascript
const messaging = getMessaging(app);

async function requestPermission() {
  const permission = await Notification.requestPermission();
  if (permission === 'granted') {
    const token = await getToken(messaging, {
      vapidKey: 'YOUR_VAPID_KEY' // Lấy từ Firebase Console > Cloud Messaging
    });
    
    // Lưu token vào Firestore
    await updateDoc(doc(db, 'users', userId), {
      fcmToken: token
    });
  }
}
```

---

## 🔐 Security Rules

### Firestore Rules cho collection `users`

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read: if request.auth != null;
      allow write: if request.auth.uid == userId;
      
      // Allow update fcmToken field
      allow update: if request.auth.uid == userId 
        && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['fcmToken']);
    }
  }
}
```

---

## 📚 API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Service info |
| `/health` | GET | Health check |
| `/api/send-notification` | POST | Gửi thông báo đến 1 user |
| `/api/notify/message` | POST | Thông báo tin nhắn mới |
| `/api/notify/friend-request` | POST | Thông báo lời mời kết bạn |
| `/api/notify/new-post` | POST | Thông báo bài viết mới |

---

## ❓ Troubleshooting

### Lỗi: "Firebase Admin initialization failed"
- Kiểm tra file service account có đúng format JSON
- Kiểm tra biến môi trường `FIREBASE_SERVICE_ACCOUNT` hoặc `GOOGLE_APPLICATION_CREDENTIALS`

### Lỗi: "User has no FCM token"
- User chưa đăng ký FCM token
- Check Firestore collection `users/{userId}` có field `fcmToken`

### Lỗi: "Invalid registration token"
- Token đã hết hạn hoặc bị revoke
- User cần refresh token và cập nhật lại Firestore

---

## 🔗 Resources

- [Firebase Admin SDK Documentation](https://firebase.google.com/docs/admin/setup)
- [FCM HTTP v1 API](https://firebase.google.com/docs/cloud-messaging/migrate-v1)
- [Firebase Console](https://console.firebase.google.com/project/chatlofi-9c2c8)
