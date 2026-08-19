const admin = require('firebase-admin');

// Firebase Admin initialization via Environment Variables
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log('🔥 Firebase Auth Admin Initialized');
} else {
  console.log('⚠️ Running in Demo Auth Mode (Bypassing Firebase token check for local tests)');
}

const verifyFirebaseToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Unauthorized: No token provided' });
  }

  const token = authHeader.split('Bearer ')[1];
  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const decodedToken = await admin.auth().verifyIdToken(token);
      req.user = decodedToken;
    } else {
      req.user = { uid: 'demo_user', phone_number: '+919876543210' };
    }
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Invalid or expired auth token' });
  }
};

module.exports = { admin, verifyFirebaseToken };