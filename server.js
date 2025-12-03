/**
 * ChatLofi Notification Server
 * FCM HTTP v1 API Server for Render deployment
 */

const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const helmet = require('helmet');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// =======================
// Middleware
// =======================
app.use(helmet());
app.use(cors());
app.use(express.json());

// =======================
// OTP Storage (in-memory, sẽ reset khi server restart)
// =======================
const otpStore = new Map(); // email -> { otp, expiresAt, attempts }
const OTP_EXPIRY_MINUTES = 5;
const MAX_OTP_ATTEMPTS = 3;

// =======================
// Email Transporter (Gmail SMTP)
// =======================
const emailTransporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.SMTP_EMAIL || 'homequy001@gmail.com',
    pass: process.env.SMTP_PASSWORD || 'ykhw pkek iuha qohn',
  },
});

// Verify email transporter on startup
emailTransporter.verify((error, success) => {
  if (error) {
    console.error('❌ Email transporter verification failed:', error);
  } else {
    console.log('✅ Email transporter ready for sending');
  }
});

/**
 * Generate random 6-digit OTP
 */
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * Send OTP email
 */
async function sendOTPEmail(email, otp) {
  const mailOptions = {
    from: {
      name: 'ChatLofi App',
      address: process.env.SMTP_EMAIL || 'homequy001@gmail.com',
    },
    to: email,
    subject: '🔐 Mã xác thực OTP - ChatLofi',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: Arial, sans-serif; background-color: #f5f5f5; margin: 0; padding: 20px; }
          .container { max-width: 500px; margin: 0 auto; background: white; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
          .header { background: linear-gradient(135deg, #006AF5, #0052CC); padding: 30px; text-align: center; }
          .header h1 { color: white; margin: 0; font-size: 24px; }
          .content { padding: 30px; text-align: center; }
          .otp-code { background: #f0f8ff; border: 2px dashed #006AF5; border-radius: 10px; padding: 20px; margin: 20px 0; }
          .otp-code h2 { color: #006AF5; font-size: 36px; letter-spacing: 8px; margin: 0; font-family: monospace; }
          .warning { background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0; text-align: left; }
          .footer { background: #f8f9fa; padding: 20px; text-align: center; color: #666; font-size: 12px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🔐 Xác Thực Email</h1>
          </div>
          <div class="content">
            <p>Xin chào!</p>
            <p>Bạn đang đăng ký tài khoản ChatLofi. Vui lòng sử dụng mã OTP bên dưới để xác thực email của bạn:</p>
            <div class="otp-code">
              <h2>${otp}</h2>
            </div>
            <div class="warning">
              <strong>⚠️ Lưu ý:</strong>
              <ul style="margin: 5px 0; padding-left: 20px;">
                <li>Mã OTP có hiệu lực trong <strong>${OTP_EXPIRY_MINUTES} phút</strong></li>
                <li>Không chia sẻ mã này với bất kỳ ai</li>
                <li>Nếu bạn không yêu cầu mã này, vui lòng bỏ qua email</li>
              </ul>
            </div>
          </div>
          <div class="footer">
            <p>© 2024 ChatLofi. All rights reserved.</p>
            <p>Email này được gửi tự động, vui lòng không trả lời.</p>
          </div>
        </div>
      </body>
      </html>
    `,
    text: `Mã OTP của bạn là: ${otp}\n\nMã có hiệu lực trong ${OTP_EXPIRY_MINUTES} phút.\nKhông chia sẻ mã này với bất kỳ ai.`,
  };

  return emailTransporter.sendMail(mailOptions);
}

// =======================
// Firebase Admin Init
// =======================
let firebaseApp;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    // Render / Prod: dùng JSON trong env
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log('✅ Firebase Admin initialized from FIREBASE_SERVICE_ACCOUNT');
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    // Local: dùng file JSON qua GOOGLE_APPLICATION_CREDENTIALS
    firebaseApp = admin.initializeApp({
      credential: admin.credential.applicationDefault(),
    });
    console.log('✅ Firebase Admin initialized from GOOGLE_APPLICATION_CREDENTIALS');
  } else {
    throw new Error(
      'No Firebase credentials found. Please set FIREBASE_SERVICE_ACCOUNT or GOOGLE_APPLICATION_CREDENTIALS'
    );
  }
} catch (error) {
  console.error('❌ Firebase Admin initialization failed:', error);
  process.exit(1);
}

const db = admin.firestore();

// =======================
// Helper functions
// =======================

/**
 * Lấy FCM token của user từ Firestore
 * @param {string} userId
 * @returns {Promise<{fcmToken: string|null, exists: boolean}>}
 */
async function getUserFcmToken(userId) {
  const userDoc = await db.collection('users').doc(userId).get();
  if (!userDoc.exists) {
    return { fcmToken: null, exists: false };
  }
  const fcmToken = userDoc.data()?.fcmToken || null;
  return { fcmToken, exists: true };
}

/**
 * Lưu notification vào Firestore để hiển thị trong Notifications Screen
 * @param {string} recipientId - ID người nhận
 * @param {string} type - Loại thông báo (message, friend_request, post_reaction, etc.)
 * @param {string} title - Tiêu đề thông báo
 * @param {string} body - Nội dung thông báo
 * @param {object} data - Dữ liệu bổ sung (senderId, postId, roomId, etc.)
 */
async function saveNotificationToFirestore(recipientId, type, title, body, data = {}) {
  try {
    // Remove undefined values from data object
    const cleanData = Object.fromEntries(
      Object.entries(data).filter(([_, value]) => value !== undefined && value !== null)
    );
    
    const notificationRef = db.collection('notifications').doc();
    await notificationRef.set({
      recipientId,
      type,
      title,
      body,
      data: cleanData,
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log('✅ Notification saved to Firestore:', notificationRef.id);
    return notificationRef.id;
  } catch (error) {
    console.error('❌ Error saving notification to Firestore:', error);
    return null;
  }
}

/**
 * Gửi 1 message FCM
 * @param {string} token
 * @param {object} payload
 */
function sendFcmToToken(token, payload) {
  // IMPORTANT: For killed state notifications, we need BOTH notification and data payloads
  // notification payload: shown by system when app is killed/background
  // data payload: handled by app when in foreground
  
  const message = {
    token,
    // Notification payload - this is what Android system shows when app is killed
    notification: payload.notification || {},
    // Data payload - this is passed to the app
    data: {
      ...(payload.data || {}),
      // Convert all values to strings as required by FCM
      click_action: 'FLUTTER_NOTIFICATION_CLICK',
    },
    android: {
      // HIGH priority ensures notification is delivered immediately
      priority: 'high',
      // TTL - time to live (how long to keep trying to deliver)
      ttl: 86400000, // 24 hours in milliseconds
      notification: {
        sound: 'default',
        color: '#006AF5',
        channelId: payload?.androidChannelId || 'messages',
        // These ensure notification shows even when app is killed
        defaultSound: true,
        defaultVibrateTimings: true,
        notificationPriority: 'PRIORITY_MAX',
        visibility: 'PUBLIC',
        // Icon for notification
        icon: 'notification_icon',
      },
    },
    apns: {
      headers: {
        'apns-priority': '10', // High priority
        'apns-push-type': 'alert',
      },
      payload: {
        aps: {
          sound: 'default',
          badge: 1,
          'content-available': 1,
          'mutable-content': 1,
        },
      },
    },
  };

  // Remove internal helper key
  delete message.androidChannelId;

  console.log('Sending FCM message:', JSON.stringify(message, null, 2));
  
  return admin.messaging().send(message);
}

// =======================
// Health Check
// =======================

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'ChatLofi Notification Server',
    version: '1.3.0', // Added OTP verification via SMTP
    timestamp: new Date().toISOString(),
    features: ['fcm_push', 'firestore_save', 'mute_check', 'auto_ping', 'otp_email'],
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', version: '1.3.0' });
});

// =======================
// API: OTP - Send OTP
// =======================

/**
 * Send OTP to email for verification
 * POST /api/otp/send
 * body: { email }
 */
app.post('/api/otp/send', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // Check if there's a recent OTP request (rate limiting)
    const existingOtp = otpStore.get(email);
    if (existingOtp && existingOtp.expiresAt > Date.now()) {
      const remainingSeconds = Math.ceil((existingOtp.expiresAt - Date.now()) / 1000);
      if (remainingSeconds > (OTP_EXPIRY_MINUTES * 60) - 60) {
        // If OTP was sent less than 1 minute ago
        return res.status(429).json({
          error: 'Please wait before requesting a new OTP',
          retryAfter: 60 - ((OTP_EXPIRY_MINUTES * 60) - remainingSeconds),
        });
      }
    }

    // Generate new OTP
    const otp = generateOTP();
    const expiresAt = Date.now() + (OTP_EXPIRY_MINUTES * 60 * 1000);

    // Store OTP
    otpStore.set(email, {
      otp,
      expiresAt,
      attempts: 0,
      createdAt: Date.now(),
    });

    // Send email
    await sendOTPEmail(email, otp);

    console.log(`📧 OTP sent to ${email}: ${otp} (expires in ${OTP_EXPIRY_MINUTES} minutes)`);

    res.json({
      success: true,
      message: 'OTP sent successfully',
      expiresIn: OTP_EXPIRY_MINUTES * 60, // seconds
    });
  } catch (error) {
    console.error('Error sending OTP:', error);
    res.status(500).json({
      error: 'Failed to send OTP',
      message: error.message,
    });
  }
});

// =======================
// API: OTP - Verify OTP
// =======================

/**
 * Verify OTP
 * POST /api/otp/verify
 * body: { email, otp }
 */
app.post('/api/otp/verify', async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ error: 'Email and OTP are required' });
    }

    const storedData = otpStore.get(email);

    if (!storedData) {
      return res.status(400).json({
        error: 'No OTP found for this email',
        code: 'OTP_NOT_FOUND',
      });
    }

    // Check if OTP expired
    if (storedData.expiresAt < Date.now()) {
      otpStore.delete(email);
      return res.status(400).json({
        error: 'OTP has expired',
        code: 'OTP_EXPIRED',
      });
    }

    // Check attempts
    if (storedData.attempts >= MAX_OTP_ATTEMPTS) {
      otpStore.delete(email);
      return res.status(400).json({
        error: 'Too many failed attempts. Please request a new OTP',
        code: 'TOO_MANY_ATTEMPTS',
      });
    }

    // Verify OTP
    if (storedData.otp !== otp.toString().trim()) {
      storedData.attempts += 1;
      otpStore.set(email, storedData);
      
      const remainingAttempts = MAX_OTP_ATTEMPTS - storedData.attempts;
      return res.status(400).json({
        error: 'Invalid OTP',
        code: 'INVALID_OTP',
        remainingAttempts,
      });
    }

    // OTP verified successfully
    otpStore.delete(email);

    console.log(`✅ OTP verified for ${email}`);

    res.json({
      success: true,
      message: 'OTP verified successfully',
      verified: true,
    });
  } catch (error) {
    console.error('Error verifying OTP:', error);
    res.status(500).json({
      error: 'Failed to verify OTP',
      message: error.message,
    });
  }
});

// =======================
// API: OTP - Resend OTP
// =======================

/**
 * Resend OTP (invalidates previous OTP)
 * POST /api/otp/resend
 * body: { email }
 */
app.post('/api/otp/resend', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Delete existing OTP
    otpStore.delete(email);

    // Generate new OTP
    const otp = generateOTP();
    const expiresAt = Date.now() + (OTP_EXPIRY_MINUTES * 60 * 1000);

    // Store new OTP
    otpStore.set(email, {
      otp,
      expiresAt,
      attempts: 0,
      createdAt: Date.now(),
    });

    // Send email
    await sendOTPEmail(email, otp);

    console.log(`📧 OTP resent to ${email}: ${otp}`);

    res.json({
      success: true,
      message: 'OTP resent successfully',
      expiresIn: OTP_EXPIRY_MINUTES * 60,
    });
  } catch (error) {
    console.error('Error resending OTP:', error);
    res.status(500).json({
      error: 'Failed to resend OTP',
      message: error.message,
    });
  }
});

// =======================
// API: send-notification (generic)
// =======================

/**
 * Send notification to specific user
 * POST /api/send-notification
 * body: { recipientId, title, body, data? }
 */
app.post('/api/send-notification', async (req, res) => {
  try {
    const { recipientId, title, body, data } = req.body;

    if (!recipientId || !title || !body) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['recipientId', 'title', 'body'],
      });
    }

    const { fcmToken, exists } = await getUserFcmToken(recipientId);

    if (!exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!fcmToken) {
      return res.status(400).json({ error: 'User has no FCM token' });
    }

    const result = await sendFcmToToken(fcmToken, {
      notification: { title, body },
      data: data || {},
      androidChannelId: 'messages',
    });

    res.json({
      success: true,
      messageId: result,
      recipientId,
    });
  } catch (error) {
    console.error('Error sending notification:', error);
    res.status(500).json({
      error: 'Failed to send notification',
      message: error.message,
    });
  }
});

// =======================
// API: notify/message
// =======================

/**
 * Send message notification
 * POST /api/notify/message
 * body: { chatId, messageId?, senderId, senderName?, text? }
 * 
 * Logic tắt thông báo (giống Facebook):
 * - Khi user A tắt thông báo chat với B:
 *   + A KHÔNG nhận push notification từ B
 *   + A VẪN nhận notification lưu trong Firestore (để xem sau)
 *   + B KHÔNG bị ảnh hưởng (vẫn nhận push bình thường)
 */
app.post('/api/notify/message', async (req, res) => {
  try {
    const { chatId, messageId, senderId, senderName, text } = req.body;

    if (!chatId || !senderId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const chatDoc = await db.collection('Chats').doc(chatId).get();

    if (!chatDoc.exists) {
      return res.status(404).json({ error: 'Chat not found' });
    }

    const chatData = chatDoc.data();
    const memberIds = Array.isArray(chatData.UID) ? chatData.UID : [];
    
    // Lấy danh sách users đã mute chat này
    const mutedUsers = Array.isArray(chatData.mutedUsers) ? chatData.mutedUsers : [];
    
    // Tất cả recipients (trừ sender) - dùng để lưu notification
    const allRecipientIds = memberIds.filter((uid) => uid !== senderId);
    
    // Recipients nhận push notification (loại bỏ những người đã mute)
    const pushRecipientIds = allRecipientIds.filter((uid) => !mutedUsers.includes(uid));
    
    console.log(`📱 Chat ${chatId}: Members=${memberIds.length}, Muted=${mutedUsers.length}, Push=${pushRecipientIds.length}, SaveNotif=${allRecipientIds.length}`);

    // === PHẦN 1: Lưu notification vào Firestore cho TẤT CẢ recipients (kể cả đã mute) ===
    // Để họ có thể xem lại trong màn hình Notifications
    if (allRecipientIds.length > 0) {
      await Promise.all(
        allRecipientIds.map((recipientId) =>
          saveNotificationToFirestore(
            recipientId,
            'new_message',
            senderName || 'Tin nhắn mới',
            text || '📷 Hình ảnh',
            {
              roomId: chatId,
              senderId,
              senderName,
              messageId,
            }
          )
        )
      );
      console.log(`💾 Saved notifications to Firestore for ${allRecipientIds.length} recipients`);
    }

    // === PHẦN 2: Gửi push notification CHỈ cho những người KHÔNG mute ===
    if (pushRecipientIds.length === 0) {
      return res.json({
        success: true,
        message: 'Notifications saved, but no push recipients (all muted)',
        sent: 0,
        saved: allRecipientIds.length,
        muted: mutedUsers.length,
      });
    }

    // Lấy token của những người không mute
    const tokenResults = await Promise.all(
      pushRecipientIds.map((uid) => getUserFcmToken(uid))
    );

    const tokens = tokenResults
      .map((r) => r.fcmToken)
      .filter((t) => typeof t === 'string' && t.trim().length > 0);

    if (tokens.length === 0) {
      return res.json({
        success: true,
        message: 'Notifications saved, but no FCM tokens for push',
        sent: 0,
        saved: allRecipientIds.length,
      });
    }

    const payload = {
      notification: {
        title: senderName || 'Tin nhắn mới',
        body: text || '📷 Hình ảnh',
      },
      data: {
        screen: 'Chat_fr',
        roomId: chatId,
        senderId: senderId,
        type: 'new_message',
        ...(messageId ? { messageId } : {}),
      },
      androidChannelId: 'messages',
    };

    const sendResults = await Promise.allSettled(
      tokens.map((token) => sendFcmToToken(token, payload))
    );

    const successful = sendResults.filter(
      (r) => r.status === 'fulfilled'
    ).length;

    res.json({
      success: true,
      sent: successful,
      total: tokens.length,
      saved: allRecipientIds.length,
      mutedCount: mutedUsers.length,
    });
  } catch (error) {
    console.error('Error sending message notification:', error);
    res.status(500).json({
      error: 'Failed to send notification',
      message: error.message,
    });
  }
});

// =======================
// API: notify/friend-request
// =======================

/**
 * Send friend request notification
 * POST /api/notify/friend-request
 * body: { recipientId, senderId, senderName? }
 */
app.post('/api/notify/friend-request', async (req, res) => {
  try {
    const { recipientId, senderId, senderName } = req.body;

    if (!recipientId || !senderId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const { fcmToken, exists } = await getUserFcmToken(recipientId);

    if (!exists) {
      return res.status(404).json({ error: 'Recipient not found' });
    }

    if (!fcmToken) {
      return res.status(400).json({ error: 'Recipient has no FCM token' });
    }

    const title =
      senderName || 'Lời mời kết bạn mới';
    const body = senderName
      ? `${senderName} đã gửi cho bạn lời mời kết bạn`
      : 'Bạn có lời mời kết bạn mới';

    const result = await sendFcmToToken(fcmToken, {
      notification: { title, body },
      data: {
        type: 'friend_request',
        senderId,
        screen: 'FriendRequests',
      },
      androidChannelId: 'friend_requests',
    });

    // Save notification to Firestore
    await saveNotificationToFirestore(
      recipientId,
      'friend_request',
      title,
      body,
      { senderId, senderName }
    );

    res.json({
      success: true,
      messageId: result,
    });
  } catch (error) {
    console.error('Error sending friend request notification:', error);
    res.status(500).json({
      error: 'Failed to send friend request notification',
      message: error.message,
    });
  }
});

// =======================
// API: notify/new-post
// =======================

/**
 * Notify followers when user creates new post
 * POST /api/notify/new-post
 * body: { postId, userId, userName? }
 */
app.post('/api/notify/new-post', async (req, res) => {
  try {
    const { postId, userId, userName } = req.body;

    if (!postId || !userId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const followersSnapshot = await db
      .collection('followers')
      .where('followingId', '==', userId)
      .get();

    if (followersSnapshot.empty) {
      return res.json({
        success: true,
        message: 'No followers to notify',
        sent: 0,
      });
    }

    const followerIds = followersSnapshot.docs
      .map((doc) => doc.data()?.followerId)
      .filter((id) => typeof id === 'string' && id.trim().length > 0);

    if (followerIds.length === 0) {
      return res.json({
        success: true,
        message: 'No valid follower IDs',
        sent: 0,
      });
    }

    const tokenResults = await Promise.all(
      followerIds.map((uid) => getUserFcmToken(uid))
    );

    const tokens = tokenResults
      .map((r) => r.fcmToken)
      .filter((t) => typeof t === 'string' && t.trim().length > 0);

    if (tokens.length === 0) {
      return res.json({
        success: true,
        message: 'No followers with FCM tokens',
        sent: 0,
      });
    }

    const payload = {
      notification: {
        title: 'Bài viết mới',
        body: userName
          ? `${userName} vừa đăng một bài viết mới`
          : 'Có bài viết mới từ người bạn đang theo dõi',
      },
      data: {
        screen: 'PostDetail',
        postId,
        userId,
        type: 'new_post',
      },
      androidChannelId: 'posts',
    };

    const sendResults = await Promise.allSettled(
      tokens.map((token) => sendFcmToToken(token, payload))
    );

    const successful = sendResults.filter(
      (r) => r.status === 'fulfilled'
    ).length;

    res.json({
      success: true,
      sent: successful,
      total: tokens.length,
    });
  } catch (error) {
    console.error('Error sending new post notification:', error);
    res.status(500).json({
      error: 'Failed to send new post notification',
      message: error.message,
    });
  }
});

// =======================
// API: notify/friend-request-accepted
// =======================

/**
 * Notify when friend request is accepted
 * POST /api/notify/friend-request-accepted
 * body: { recipientId, acceptorId, acceptorName? }
 */
app.post('/api/notify/friend-request-accepted', async (req, res) => {
  try {
    const { recipientId, acceptorId, acceptorName } = req.body;

    if (!recipientId || !acceptorId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const { fcmToken, exists } = await getUserFcmToken(recipientId);

    if (!exists) {
      return res.status(404).json({ error: 'Recipient not found' });
    }

    if (!fcmToken) {
      return res.status(400).json({ error: 'Recipient has no FCM token' });
    }

    const title = 'Lời mời kết bạn được chấp nhận';
    const body = acceptorName
      ? `${acceptorName} đã chấp nhận lời mời kết bạn của bạn`
      : 'Lời mời kết bạn của bạn đã được chấp nhận';

    const result = await sendFcmToToken(fcmToken, {
      notification: { title, body },
      data: {
        type: 'friend_request_accepted',
        acceptorId,
        screen: 'Personal_page',
      },
      androidChannelId: 'friend_requests',
    });

    // Save notification to Firestore
    await saveNotificationToFirestore(
      recipientId,
      'friend_accept',
      title,
      body,
      { senderId: acceptorId, senderName: acceptorName }
    );

    res.json({
      success: true,
      messageId: result,
    });
  } catch (error) {
    console.error('Error sending friend request accepted notification:', error);
    res.status(500).json({
      error: 'Failed to send notification',
      message: error.message,
    });
  }
});

// =======================
// API: notify/post-comment
// =======================

/**
 * Notify post owner when someone comments
 * POST /api/notify/post-comment
 * body: { postId, postOwnerId, commenterId, commenterName?, commentText? }
 */
app.post('/api/notify/post-comment', async (req, res) => {
  try {
    const { postId, postOwnerId, commenterId, commenterName, commentText } = req.body;

    if (!postId || !postOwnerId || !commenterId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Don't notify if user comments on their own post
    if (postOwnerId === commenterId) {
      return res.json({
        success: true,
        message: 'User commented on their own post, no notification needed',
        sent: 0,
      });
    }

    const { fcmToken, exists } = await getUserFcmToken(postOwnerId);

    if (!exists) {
      return res.status(404).json({ error: 'Post owner not found' });
    }

    if (!fcmToken) {
      return res.status(400).json({ error: 'Post owner has no FCM token' });
    }

    const title = 'Bình luận mới';
    const body = commenterName
      ? `${commenterName} đã bình luận: "${commentText?.substring(0, 50) || '...'}"` 
      : 'Có người bình luận bài viết của bạn';

    const result = await sendFcmToToken(fcmToken, {
      notification: { title, body },
      data: {
        type: 'post_comment',
        postId,
        commenterId,
        screen: 'PostDetail',
      },
      androidChannelId: 'posts',
    });

    // Save notification to Firestore
    await saveNotificationToFirestore(
      postOwnerId,
      'post_comment',
      title,
      body,
      { postId, senderId: commenterId, senderName: commenterName, commentText }
    );

    res.json({
      success: true,
      messageId: result,
    });
  } catch (error) {
    console.error('Error sending post comment notification:', error);
    res.status(500).json({
      error: 'Failed to send notification',
      message: error.message,
    });
  }
});

// =======================
// API: notify/post-reaction
// =======================

/**
 * Notify post owner when someone reacts
 * POST /api/notify/post-reaction
 * body: { postId, postOwnerId, reactorId, reactorName?, reactionType? }
 */
app.post('/api/notify/post-reaction', async (req, res) => {
  try {
    const { postId, postOwnerId, reactorId, reactorName, reactionType } = req.body;

    if (!postId || !postOwnerId || !reactorId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Don't notify if user reacts to their own post
    if (postOwnerId === reactorId) {
      return res.json({
        success: true,
        message: 'User reacted to their own post, no notification needed',
        sent: 0,
      });
    }

    const { fcmToken, exists } = await getUserFcmToken(postOwnerId);

    if (!exists) {
      return res.status(404).json({ error: 'Post owner not found' });
    }

    if (!fcmToken) {
      return res.status(400).json({ error: 'Post owner has no FCM token' });
    }

    // Map reaction types to emojis
    const reactionEmojis = {
      like: '👍',
      love: '❤️',
      haha: '😆',
      wow: '😮',
      sad: '😢',
      angry: '😠',
    };
    const emoji = reactionEmojis[reactionType] || '👍';

    const title = 'Biểu cảm mới';
    const body = reactorName
      ? `${reactorName} ${emoji} bài viết của bạn`
      : `Có người ${emoji} bài viết của bạn`;

    const result = await sendFcmToToken(fcmToken, {
      notification: { title, body },
      data: {
        type: 'post_reaction',
        postId,
        reactorId,
        reactionType: reactionType || 'like',
        screen: 'PostDetail',
      },
      androidChannelId: 'posts',
    });

    // Save notification to Firestore
    await saveNotificationToFirestore(
      postOwnerId,
      'post_reaction',
      title,
      body,
      { postId, senderId: reactorId, senderName: reactorName, reactionType }
    );

    res.json({
      success: true,
      messageId: result,
    });
  } catch (error) {
    console.error('Error sending post reaction notification:', error);
    res.status(500).json({
      error: 'Failed to send notification',
      message: error.message,
    });
  }
});

// =======================
// API: notify/post-share
// =======================

/**
 * Notify post owner when someone shares their post
 * POST /api/notify/post-share
 * body: { postId, postOwnerId, sharerId, sharerName? }
 */
app.post('/api/notify/post-share', async (req, res) => {
  try {
    const { postId, postOwnerId, sharerId, sharerName } = req.body;

    if (!postId || !postOwnerId || !sharerId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Don't notify if user shares their own post
    if (postOwnerId === sharerId) {
      return res.json({
        success: true,
        message: 'User shared their own post, no notification needed',
        sent: 0,
      });
    }

    const { fcmToken, exists } = await getUserFcmToken(postOwnerId);

    if (!exists) {
      return res.status(404).json({ error: 'Post owner not found' });
    }

    if (!fcmToken) {
      return res.status(400).json({ error: 'Post owner has no FCM token' });
    }

    const title = 'Bài viết được chia sẻ';
    const body = sharerName
      ? `${sharerName} đã chia sẻ bài viết của bạn`
      : 'Có người đã chia sẻ bài viết của bạn';

    const result = await sendFcmToToken(fcmToken, {
      notification: { title, body },
      data: {
        type: 'post_share',
        postId,
        sharerId,
        screen: 'PostDetail',
      },
      androidChannelId: 'posts',
    });

    // Save notification to Firestore
    await saveNotificationToFirestore(
      postOwnerId,
      'post_share',
      title,
      body,
      { postId, senderId: sharerId, senderName: sharerName }
    );

    res.json({
      success: true,
      messageId: result,
    });
  } catch (error) {
    console.error('Error sending post share notification:', error);
    res.status(500).json({
      error: 'Failed to send notification',
      message: error.message,
    });
  }
});

// =======================
// API: notify/comment-reply
// =======================

/**
 * Notify when someone replies to a comment
 * POST /api/notify/comment-reply
 * body: { postId, commentOwnerId, replierId, replierName?, replyText? }
 */
app.post('/api/notify/comment-reply', async (req, res) => {
  try {
    const { postId, commentOwnerId, replierId, replierName, replyText } = req.body;

    if (!postId || !commentOwnerId || !replierId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Don't notify if user replies to their own comment
    if (commentOwnerId === replierId) {
      return res.json({
        success: true,
        message: 'User replied to their own comment, no notification needed',
        sent: 0,
      });
    }

    const { fcmToken, exists } = await getUserFcmToken(commentOwnerId);

    if (!exists) {
      return res.status(404).json({ error: 'Comment owner not found' });
    }

    if (!fcmToken) {
      return res.status(400).json({ error: 'Comment owner has no FCM token' });
    }

    const title = 'Trả lời bình luận';
    const body = replierName
      ? `${replierName} đã trả lời bình luận của bạn: "${replyText?.substring(0, 50) || '...'}"`
      : 'Có người trả lời bình luận của bạn';

    const result = await sendFcmToToken(fcmToken, {
      notification: { title, body },
      data: {
        type: 'comment_reply',
        postId,
        replierId,
        screen: 'PostDetail',
      },
      androidChannelId: 'posts',
    });

    // Save notification to Firestore
    await saveNotificationToFirestore(
      commentOwnerId,
      'comment_reply',
      title,
      body,
      { postId, senderId: replierId, senderName: replierName, replyText }
    );

    res.json({
      success: true,
      messageId: result,
    });
  } catch (error) {
    console.error('Error sending comment reply notification:', error);
    res.status(500).json({
      error: 'Failed to send notification',
      message: error.message,
    });
  }
});

// =======================
// API: notify/comment-like
// =======================

/**
 * Notify when someone likes a comment
 * POST /api/notify/comment-like
 * body: { postId, commentId, commentOwnerId, likerId, likerName? }
 */
app.post('/api/notify/comment-like', async (req, res) => {
  try {
    const { postId, commentId, commentOwnerId, likerId, likerName } = req.body;

    if (!postId || !commentId || !commentOwnerId || !likerId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Don't notify if user likes their own comment
    if (commentOwnerId === likerId) {
      return res.json({
        success: true,
        message: 'User liked their own comment, no notification needed',
        sent: 0,
      });
    }

    const { fcmToken, exists } = await getUserFcmToken(commentOwnerId);

    if (!exists) {
      return res.status(404).json({ error: 'Comment owner not found' });
    }

    if (!fcmToken) {
      return res.status(400).json({ error: 'Comment owner has no FCM token' });
    }

    const title = 'Bình luận được thích';
    const body = likerName
      ? `${likerName} đã thích bình luận của bạn`
      : 'Có người thích bình luận của bạn';

    const result = await sendFcmToToken(fcmToken, {
      notification: { title, body },
      data: {
        type: 'comment_like',
        postId,
        commentId,
        likerId,
        screen: 'PostDetail',
      },
      androidChannelId: 'posts',
    });

    // Save notification to Firestore
    await saveNotificationToFirestore(
      commentOwnerId,
      'comment_like',
      title,
      body,
      { postId, commentId, senderId: likerId, senderName: likerName }
    );

    res.json({
      success: true,
      messageId: result,
    });
  } catch (error) {
    console.error('Error sending comment like notification:', error);
    res.status(500).json({
      error: 'Failed to send notification',
      message: error.message,
    });
  }
});

// =======================
// API: notify/group-invite
// =======================

/**
 * Notify when user is invited to a group
 * POST /api/notify/group-invite
 * body: { recipientId, groupId, groupName?, inviterId, inviterName? }
 */
app.post('/api/notify/group-invite', async (req, res) => {
  try {
    const { recipientId, groupId, groupName, inviterId, inviterName } = req.body;

    if (!recipientId || !groupId || !inviterId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const { fcmToken, exists } = await getUserFcmToken(recipientId);

    if (!exists) {
      return res.status(404).json({ error: 'Recipient not found' });
    }

    if (!fcmToken) {
      return res.status(400).json({ error: 'Recipient has no FCM token' });
    }

    const title = 'Lời mời vào nhóm';
    const body = inviterName && groupName
      ? `${inviterName} đã mời bạn vào nhóm "${groupName}"`
      : 'Bạn được mời vào một nhóm chat mới';

    const result = await sendFcmToToken(fcmToken, {
      notification: { title, body },
      data: {
        type: 'group_invite',
        groupId,
        inviterId,
        screen: 'Chat_fr',
      },
      androidChannelId: 'messages',
    });

    // Save notification to Firestore
    await saveNotificationToFirestore(recipientId, 'group_invite', title, body, {
      groupId,
      groupName: groupName || '',
      inviterId,
      inviterName: inviterName || '',
      screen: 'Chat_fr',
    });

    res.json({
      success: true,
      messageId: result,
    });
  } catch (error) {
    console.error('Error sending group invite notification:', error);
    res.status(500).json({
      error: 'Failed to send notification',
      message: error.message,
    });
  }
});

// =======================
// API: notify/mention
// =======================

/**
 * Notify when user is mentioned in a post or comment
 * POST /api/notify/mention
 * body: { recipientId, mentionerId, mentionerName?, postId?, commentId?, type: 'post' | 'comment' }
 */
app.post('/api/notify/mention', async (req, res) => {
  try {
    const { recipientId, mentionerId, mentionerName, postId, commentId, type } = req.body;

    if (!recipientId || !mentionerId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Don't notify if user mentions themselves
    if (recipientId === mentionerId) {
      return res.json({
        success: true,
        message: 'User mentioned themselves, no notification needed',
        sent: 0,
      });
    }

    const { fcmToken, exists } = await getUserFcmToken(recipientId);

    if (!exists) {
      return res.status(404).json({ error: 'Recipient not found' });
    }

    if (!fcmToken) {
      return res.status(400).json({ error: 'Recipient has no FCM token' });
    }

    const title = 'Bạn được nhắc đến';
    const body = mentionerName
      ? `${mentionerName} đã nhắc đến bạn trong ${type === 'comment' ? 'bình luận' : 'bài viết'}`
      : `Bạn được nhắc đến trong một ${type === 'comment' ? 'bình luận' : 'bài viết'}`;

    const result = await sendFcmToToken(fcmToken, {
      notification: { title, body },
      data: {
        type: 'mention',
        mentionType: type || 'post',
        postId: postId || '',
        commentId: commentId || '',
        mentionerId,
        screen: 'PostDetail',
      },
      androidChannelId: 'posts',
    });

    // Save notification to Firestore
    await saveNotificationToFirestore(recipientId, 'mention', title, body, {
      mentionType: type || 'post',
      postId: postId || '',
      commentId: commentId || '',
      mentionerId,
      mentionerName: mentionerName || '',
      screen: 'PostDetail',
    });

    res.json({
      success: true,
      messageId: result,
    });
  } catch (error) {
    console.error('Error sending mention notification:', error);
    res.status(500).json({
      error: 'Failed to send notification',
      message: error.message,
    });
  }
});

// =======================
// 404 & Error handlers
// =======================

app.use((req, res, next) => {
  res.status(404).json({
    error: 'Not found',
    path: req.originalUrl,
  });
});

app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message,
  });
});

// =======================
// Auto-ping to keep Render server alive
// =======================
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || 'https://chatlofi-notification.onrender.com';
const PING_INTERVAL = 14 * 60 * 1000; // 14 minutes (before 15min timeout)

function startAutoPing() {
  // Only run auto-ping in production (on Render)
  if (process.env.NODE_ENV !== 'production' && !process.env.RENDER) {
    console.log('⏸️ Auto-ping disabled (not in production)');
    return;
  }

  console.log(`🔄 Auto-ping enabled - will ping every 14 minutes to: ${RENDER_URL}`);
  
  setInterval(async () => {
    try {
      const response = await fetch(`${RENDER_URL}/health`);
      const data = await response.json();
      console.log(`✅ Auto-ping successful at ${new Date().toISOString()} - Status: ${data.status}`);
    } catch (error) {
      console.error(`❌ Auto-ping failed at ${new Date().toISOString()}:`, error.message);
    }
  }, PING_INTERVAL);
}

// =======================
// Start server
// =======================
app.listen(PORT, () => {
  console.log(`🚀 Notification Server running on port ${PORT}`);
  console.log(`📡 Health check: http://localhost:${PORT}/health`);
  
  // Start auto-ping after server is running
  startAutoPing();
});
