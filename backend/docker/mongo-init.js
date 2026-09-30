// MongoDB initialization script
// Creates the application database and user

// Switch to the clouddesk database
db = db.getSiblingDB('clouddesk');

// Create application user with readWrite access
// MONGO_USERNAME / MONGO_PASSWORD must be passed to the mongodb container and
// match the credentials in the backend's MONGODB_URI (authSource=clouddesk)
db.createUser({
  user: process.env.MONGO_USERNAME || 'clouddesk',
  pwd: process.env.MONGO_PASSWORD || 'clouddesk_app_password',
  roles: [
    {
      role: 'readWrite',
      db: 'clouddesk'
    }
  ]
});

// Create indexes for better performance
db.users.createIndex({ email: 1 }, { unique: true });
db.users.createIndex({ createdAt: -1 });

db.instances.createIndex({ userId: 1, status: 1 });
db.instances.createIndex({ userId: 1, name: 1 });
db.instances.createIndex({ tags: 1 });
db.instances.createIndex({ createdAt: -1 });

db.sessions.createIndex({ userId: 1, status: 1 });
db.sessions.createIndex({ instanceId: 1, status: 1 });
db.sessions.createIndex({ lastActivityAt: 1, status: 1 });
db.sessions.createIndex({ createdAt: -1 });

db.auditlogs.createIndex({ userId: 1, createdAt: -1 });
db.auditlogs.createIndex({ action: 1, createdAt: -1 });
db.auditlogs.createIndex({ createdAt: 1 }, { expireAfterSeconds: 7776000 }); // 90 days TTL

print('CloudDesk database initialized successfully');
