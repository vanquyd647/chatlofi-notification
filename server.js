/**
 * ChatLofi Notification Server
 * FCM HTTP v1 API Server for Render deployment
 */

const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const helmet = require('helmet');
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
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
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
    const recipientIds = memberIds.filter((uid) => uid !== senderId);

    if (recipientIds.length === 0) {
      return res.json({
        success: true,
        message: 'No recipients to notify',
        sent: 0,
      });
    }

    // Lấy token của tất cả recipients song song
    const tokenResults = await Promise.all(
      recipientIds.map((uid) => getUserFcmToken(uid))
    );

    const tokens = tokenResults
      .map((r) => r.fcmToken)
      .filter((t) => typeof t === 'string' && t.trim().length > 0);

    if (tokens.length === 0) {
      return res.json({
        success: true,
        message: 'No recipients with FCM tokens',
        sent: 0,
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
// Start server
// =======================
app.listen(PORT, () => {
  console.log(`🚀 Notification Server running on port ${PORT}`);
  console.log(`📡 Health check: http://localhost:${PORT}/health`);
});
