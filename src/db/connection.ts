import mongoose from 'mongoose';

let connected = false;

/**
 * Establishes a connection to MongoDB using the MONGODB_URI environment variable.
 * Idempotent — calling multiple times is safe.
 */
export async function connectDB(uri?: string): Promise<void> {
  if (connected) return;

  const connectionUri = uri ?? process.env.MONGODB_URI ?? 'mongodb://localhost:27017/model-misalignment';

  await mongoose.connect(connectionUri, {
    serverSelectionTimeoutMS: 5000,
  });

  connected = true;
  mongoose.connection.on('error', (err) => {
    console.error('[MongoDB] Connection error:', err);
  });
}

/**
 * Gracefully closes the MongoDB connection.
 */
export async function disconnectDB(): Promise<void> {
  if (!connected) return;
  await mongoose.disconnect();
  connected = false;
}
