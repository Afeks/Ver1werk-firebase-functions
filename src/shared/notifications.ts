import * as admin from 'firebase-admin';
import { NotificationPayload } from './types';

const COLLECTION_EVENTS = 'Events';
const COLLECTION_NOTIFICATIONS = 'Notifications';

export async function createNotification(
  eventId: string,
  payload: NotificationPayload
): Promise<string> {
  if (!eventId) {
    throw new Error('Event ID is required to create a notification');
  }
  if (!payload.title || !payload.message) {
    throw new Error('Notification must contain at least title and message');
  }

  const data = {
    title: payload.title,
    message: payload.message,
    pointOfService: payload.pointOfService || null,
    price: payload.price ?? null,
    itemId: payload.itemId || null,
    severity: payload.severity || 'info',
    action: payload.action || null,
    isRead: payload.isRead ?? false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  const docRef = await admin
    .firestore()
    .collection(COLLECTION_EVENTS)
    .doc(eventId)
    .collection(COLLECTION_NOTIFICATIONS)
    .add(data);

  return docRef.id;
}

