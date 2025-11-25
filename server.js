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

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Initialize Firebase Admin
let firebaseApp;
try {
  // For Render: Use environment variable with service account JSON
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log('✅ Firebase Admin initialized from environment variable');
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    // For local development: Use file path
    firebaseApp = admin.initializeApp({
      credential: admin.credential.applicationDefault()
    });
    console.log('✅ Firebase Admin initialized from credentials file');
  } else {
    throw new Error('No Firebase credentials found');
  }
} catch (error) {
  console.error('❌ Firebase Admin initialization failed:', error);
  process.exit(1);
}

const db = admin.firestore();

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'ChatLofi Notification Server',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

/**
 * Send notification to specific user
 * POST /api/send-notification
 */
app.post('/api/send-notification', async (req, res) => {
  try {
    const { recipientId, title, body, data } = req.body;

    // Validate input
    if (!recipientId || !title || !body) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['recipientId', 'title', 'body']
      });
    }

    // Get recipient's FCM token from Firestore
    const userDoc = await db.collection('users').doc(recipientId).get();
    
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    const fcmToken = userDoc.data()?.fcmToken;
    
    if (!fcmToken) {
      return res.status(400).json({ error: 'User has no FCM token' });
    }

    // Send notification using FCM HTTP v1 API
    const message = {
      token: fcmToken,
      notification: {
        title: title,
        body: body
      },
      data: data || {},
      android: {
        priority: 'high',
        notification: {
          sound: 'default',
          color: '#006AF5',
          channelId: 'messages'
        }
      },
      apns: {
        payload: {
          aps: {
            sound: 'default',
            badge: 1
          }
        }
      }
    };

    const result = await admin.messaging().send(message);

    res.json({
      success: true,
      messageId: result,
      recipientId: recipientId
    });

  } catch (error) {
    console.error('Error sending notification:', error);
    res.status(500).json({
      error: 'Failed to send notification',
      message: error.message
    });
  }
});

/**
 * Send message notification
 * POST /api/notify/message
 */
app.post('/api/notify/message', async (req, res) => {
  try {
    const { chatId, messageId, senderId, senderName, text } = req.body;

    if (!chatId || !senderId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Get chat members
    const chatDoc = await db.collection('Chats').doc(chatId).get();
    
    if (!chatDoc.exists) {
      return res.status(404).json({ error: 'Chat not found' });
    }

    const chatData = chatDoc.data();
    const recipientIds = chatData.UID.filter(uid => uid !== senderId);

    // Get FCM tokens for all recipients
    const tokens = [];
    for (const uid of recipientIds) {
      const userDoc = await db.collection('users').doc(uid).get();
      if (userDoc.exists) {
        const fcmToken = userDoc.data()?.fcmToken;
        if (fcmToken) {
          tokens.push(fcmToken);
        }
      }
    }

    if (tokens.length === 0) {
      return res.json({
        success: true,
        message: 'No recipients with FCM tokens',
        sent: 0
      });
    }

    // Send notification to each recipient
    const promises = tokens.map(token => {
      const message = {
        token: token,
        notification: {
          title: senderName || 'Tin nhắn mới',
          body: text || '📷 Hình ảnh'
        },
        data: {
          screen: 'Chat_fr',
          roomId: chatId,
          senderId: senderId,
          type: 'new_message'
        },
        android: {
          priority: 'high',
          notification: {
            sound: 'default',
            color: '#006AF5',
            channelId: 'messages'
          }
        },
        apns: {
          payload: {
            aps: {
              sound: 'default',
              badge: 1
            }
          }
        }
      };

      return admin.messaging().send(message);
    });

    const results = await Promise.allSettled(promises);
    const successful = results.filter(r => r.status === 'fulfilled').length;

    res.json({
      success: true,
      sent: successful,
      total: tokens.length
    });

  } catch (error) {
    console.error('Error sending message notification:', error);
    res.status(500).json({
      error: 'Failed to send notification',
      message: error.message
    });
  }
});

/**
 * Send friend request notification
 * POST /api/notify/friend-request
 */
app.post('/api/notify/friend-request', async (req, res) => {
  try {
    const { recipientId, senderId, senderName } = req.body;

    if (!recipientId || !senderId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Get recipient's FCM token
    const userDoc = await db.collection('users').doc(recipientId).get();
    
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'Recipient not found' });
    }

    const fcmToken = userDoc.data()?.fcmToken;
    
    if (!fcmToken) {
      return res.status(400).json({ error: 'Recipient has no FCM token' });
    }

    // Send notification
    const message = {
      token: fcmToken,
      notification: {
        title: 'Lời mời kết bạn',
        body: `${senderName || 'Ai đó'} đã gửi lời mời kết bạn`
      },
      data: {
        screen: 'FriendRequest',
        senderId: senderId,
        type: 'friend_request'
      },
      android: {
        priority: 'high',
        notification: {
          sound: 'default',
          color: '#006AF5',
          channelId: 'friend_requests'
        }
      },
      apns: {
        payload: {
          aps: {
            sound: 'default',
            badge: 1
          }
        }
      }
    };

    const result = await admin.messaging().send(message);

    res.json({
      success: true,
      messageId: result
    });

  } catch (error) {
    console.error('Error sending friend request notification:', error);
    res.status(500).json({
      error: 'Failed to send notification',
      message: error.message
    });
  }
});

/**
 * Send new post notification
 * POST /api/notify/new-post
 */
app.post('/api/notify/new-post', async (req, res) => {
  try {
    const { postId, userId, userName } = req.body;

    if (!postId || !userId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Get all followers
    const followersSnapshot = await db.collection('followers')
      .where('followingId', '==', userId)
      .get();

    if (followersSnapshot.empty) {
      return res.json({
        success: true,
        message: 'No followers found',
        sent: 0
      });
    }

    // Get FCM tokens for all followers
    const tokens = [];
    for (const doc of followersSnapshot.docs) {
      const followerDoc = await db.collection('users')
        .doc(doc.data().followerId)
        .get();
      
      if (followerDoc.exists) {
        const fcmToken = followerDoc.data()?.fcmToken;
        if (fcmToken) {
          tokens.push(fcmToken);
        }
      }
    }

    if (tokens.length === 0) {
      return res.json({
        success: true,
        message: 'No followers with FCM tokens',
        sent: 0
      });
    }

    // Send notification to each follower
    const promises = tokens.map(token => {
      const message = {
        token: token,
        notification: {
          title: 'Bài viết mới',
          body: `${userName || 'Ai đó'} đã đăng bài viết mới`
        },
        data: {
          screen: 'PostDetail',
          postId: postId,
          userId: userId,
          type: 'new_post'
        },
        android: {
          priority: 'high',
          notification: {
            sound: 'default',
            color: '#006AF5',
            channelId: 'posts'
          }
        },
        apns: {
          payload: {
            aps: {
              sound: 'default',
              badge: 1
            }
          }
        }
      };

      return admin.messaging().send(message);
    });

    const results = await Promise.allSettled(promises);
    const successful = results.filter(r => r.status === 'fulfilled').length;

    res.json({
      success: true,
      sent: successful,
      total: tokens.length
    });

  } catch (error) {
    console.error('Error sending new post notification:', error);
    res.status(500).json({
      error: 'Failed to send notification',
      message: error.message
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Notification Server running on port ${PORT}`);
  console.log(`📡 Health check: http://localhost:${PORT}/health`);
});
