import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';

const COLLECTION_EVENTS = 'Events';
const COLLECTION_NOTIFICATIONS = 'Notifications';
const COLLECTION_ORDERS = 'Orders';
const COLLECTION_POS = 'Points-of-Sale';
const COLLECTION_ITEMS = 'Items';

interface NotificationData {
  status?: string;
  orderId?: string;
  itemIds?: string[];
  pointOfService?: string;
  price?: number;
}

async function cancelItemsInOrderCollection(
  orderRef: FirebaseFirestore.DocumentReference,
  itemIds: string[]
): Promise<void> {
  if (itemIds.length === 0) {
    return;
  }

  const itemsCollection = orderRef.collection(COLLECTION_ITEMS);

  const chunkSize = 10;
  for (let i = 0; i < itemIds.length; i += chunkSize) {
    const chunk = itemIds.slice(i, i + chunkSize);
    const itemsSnapshot = await itemsCollection
      .where('id', 'in', chunk)
      .get();

    const updates: Array<Promise<FirebaseFirestore.WriteResult>> = [];

    for (const itemDoc of itemsSnapshot.docs) {
      updates.push(
        itemDoc.ref.set(
          { status: 'canceled', count: 0, quantity: 0 },
          { merge: true }
        )
      );
    }

    await Promise.all(updates);
  }
}

async function recalculateOrderTotals(orderRef: FirebaseFirestore.DocumentReference) {
  const itemsSnapshot = await orderRef.collection(COLLECTION_ITEMS).get();

  let totalPrice = 0;

  for (const itemDoc of itemsSnapshot.docs) {
    const data = itemDoc.data();
    const status = data.status || 'active';
    if (status === 'canceled') {
      continue;
    }
    const price = Number(data.price ?? 0);
    const count = Number(data.count ?? 0);
    if (Number.isFinite(price) && Number.isFinite(count) && count > 0) {
      totalPrice += price * count;
    }
  }

  await orderRef.set({ totalPrice }, { merge: true });
}

async function cancelItemsInPosOrders(
  eventId: string,
  orderId: string,
  itemIds: string[]
): Promise<void> {
  const db = admin.firestore();
  const posSnapshot = await db
    .collection(COLLECTION_EVENTS)
    .doc(eventId)
    .collection(COLLECTION_POS)
    .get();

  const tasks: Array<Promise<void>> = [];

  for (const posDoc of posSnapshot.docs) {
    const orderRef = posDoc.ref.collection(COLLECTION_ORDERS).doc(orderId);
    const orderSnapshot = await orderRef.get();
    if (!orderSnapshot.exists) {
      continue;
    }
    const cancelTask = cancelItemsInOrderCollection(orderRef, itemIds)
      .then(() => recalculateOrderTotals(orderRef));
    tasks.push(cancelTask);
  }

  await Promise.all(tasks);
}

export const onNotificationRefundUpdate = functions
  .region('europe-west1')
  .firestore.document(
    `${COLLECTION_EVENTS}/{eventId}/${COLLECTION_NOTIFICATIONS}/{notificationId}`
  )
  .onUpdate(async (change, context) => {
    const beforeData = change.before.data() as NotificationData | undefined;
    const afterData = change.after.data() as NotificationData | undefined;

    if (!afterData || !afterData.orderId || !afterData.itemIds) {
      return null;
    }

    if (beforeData?.status === 'refund' || afterData.status !== 'refund') {
      return null;
    }

    const { eventId } = context.params;
    const orderId = afterData.orderId;
    const itemIds = afterData.itemIds;

    const db = admin.firestore();

    const orderRef = db
      .collection(COLLECTION_EVENTS)
      .doc(eventId)
      .collection(COLLECTION_ORDERS)
      .doc(orderId);

    await cancelItemsInOrderCollection(orderRef, itemIds);
    await recalculateOrderTotals(orderRef);
    await cancelItemsInPosOrders(eventId, orderId, itemIds);

    functions.logger.info('Processed refund notification', {
      eventId,
      notificationId: context.params.notificationId,
      orderId,
      itemIds,
    });

    return null;
  });

