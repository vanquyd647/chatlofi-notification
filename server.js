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
    version: '1.1.0', // Updated to trigger redeploy with Firestore save
    timestamp: new Date().toISOString(),
    features: ['fcm_push', 'firestore_save'],
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', version: '1.1.0' });
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

    // Save notification to Firestore for each recipient
    await Promise.all(
      recipientIds.map((recipientId) =>
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
// Start server
// =======================
app.listen(PORT, () => {
  console.log(`🚀 Notification Server running on port ${PORT}`);
  console.log(`📡 Health check: http://localhost:${PORT}/health`);
});
