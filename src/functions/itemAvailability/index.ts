import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { countOpenOrdersForStore } from '../../shared/database-helpers';
import { createNotification } from '../../shared/notifications';
import { NotificationPayload } from '../../shared/types';

const COLLECTION_EVENTS = 'Events';
const COLLECTION_POS = 'Points-of-Sale';
const COLLECTION_ORDERS = 'Orders';
const COLLECTION_ITEMS = 'Items';
const globalAvailabilityCache: Map<string, boolean> = new Map();

function getGlobalCacheKey(eventId: string, itemId: string): string {
  return `${eventId}:${itemId}`;
}

function setGlobalAvailabilityCache(
  eventId: string,
  itemId: string,
  value: boolean
): void {
  globalAvailabilityCache.set(getGlobalCacheKey(eventId, itemId), value);
}

async function isItemGloballyAvailable(
  eventId: string,
  itemId: string,
  cache?: Map<string, boolean>
): Promise<boolean> {
  if (cache && cache.has(itemId)) {
    return cache.get(itemId)!;
  }

  const cacheKey = getGlobalCacheKey(eventId, itemId);
  if (!cache && globalAvailabilityCache.has(cacheKey)) {
    return globalAvailabilityCache.get(cacheKey)!;
  }

  const docSnapshot = await admin
    .firestore()
    .collection(COLLECTION_EVENTS)
    .doc(eventId)
    .collection(COLLECTION_ITEMS)
    .doc(itemId)
    .get();

  const data = docSnapshot.data();
  const available =
    !docSnapshot.exists ||
    (data?.isAvailable !== undefined ? data.isAvailable !== false : true);

  if (cache) {
    cache.set(itemId, available);
  } else {
    setGlobalAvailabilityCache(eventId, itemId, available);
  }

  return available;
}

interface CandidateStore {
  id: string;
  name: string;
  openOrders: number;
}

function isItemFlagAvailable(
  data: FirebaseFirestore.DocumentData | undefined
): boolean {
  if (!data) {
    return false;
  }
  if (typeof data.isAvailable === 'boolean') {
    return data.isAvailable;
  }
  return true;
}

function extractCountFromItem(
  data: FirebaseFirestore.DocumentData | undefined
): number {
  if (!data) {
    return 0;
  }
  const raw = data.count ?? data.quantity ?? 0;
  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }
  return Math.floor(numeric);
}

function sanitizeItemData(
  source: FirebaseFirestore.DocumentData,
  newCount: number
): FirebaseFirestore.DocumentData {
  const sanitized = {
    ...source,
    count: newCount,
    selectedExtras: Array.isArray(source.selectedExtras)
      ? source.selectedExtras
      : [],
    excludedIngredients: Array.isArray(source.excludedIngredients)
      ? source.excludedIngredients
      : [],
  };

  delete (sanitized as any).quantity;
  return sanitized;
}

async function findCandidateStores(
  eventId: string,
  excludePosId: string,
  itemId: string
): Promise<CandidateStore[]> {
  const db = admin.firestore();
  const posSnapshot = await db
    .collection(COLLECTION_EVENTS)
    .doc(eventId)
    .collection(COLLECTION_POS)
    .get();

  const candidates: CandidateStore[] = [];

  for (const posDoc of posSnapshot.docs) {
    if (posDoc.id === excludePosId) {
      continue;
    }

    try {
      const itemDoc = await posDoc.ref
        .collection(COLLECTION_ITEMS)
        .doc(itemId)
        .get();

      if (!itemDoc.exists) {
        continue;
      }

      const itemData = itemDoc.data();
      if (!isItemFlagAvailable(itemData)) {
        continue;
      }

      const openOrders = await countOpenOrdersForStore(posDoc.id, eventId);
      candidates.push({
        id: posDoc.id,
        name: posDoc.data()?.name || '',
        openOrders,
      });
    } catch (error) {
      functions.logger.error(
        'Failed to evaluate candidate store',
        {
          eventId,
          itemId,
          candidatePosId: posDoc.id,
        },
        error as Error
      );
    }
  }

  return candidates.sort((a, b) => a.openOrders - b.openOrders);
}

async function ensureTargetOrderDocument(
  targetOrderRef: FirebaseFirestore.DocumentReference,
  sourceOrderData: FirebaseFirestore.DocumentData
): Promise<void> {
  const targetSnapshot = await targetOrderRef.get();
  if (targetSnapshot.exists) {
    const updatePayload: FirebaseFirestore.DocumentData = {};
    const targetData = targetSnapshot.data() ?? {};

    if (targetData.orderStatus !== 'open') {
      updatePayload.orderStatus = 'open';
    }

    if (targetData.transferredAt !== undefined) {
      updatePayload.transferredAt = admin.firestore.FieldValue.delete();
    }

    if (Object.keys(updatePayload).length > 0) {
      await targetOrderRef.update(updatePayload);
    }
    return;
  }

  const payload: FirebaseFirestore.DocumentData = {
    id: sourceOrderData.id || targetOrderRef.id,
    orderStatus: sourceOrderData.orderStatus || 'open',
    orderDate:
      sourceOrderData.orderDate ||
      admin.firestore.FieldValue.serverTimestamp(),
    servingPointName: sourceOrderData.servingPointName || null,
    servingPointLocation: sourceOrderData.servingPointLocation || null,
    note: sourceOrderData.note ?? null,
  };

  if (sourceOrderData.tabletNumber !== undefined) {
    payload.tabletNumber = sourceOrderData.tabletNumber;
  }

  await targetOrderRef.set(payload, { merge: true });
}

async function transferItemsForOrder(
  eventId: string,
  sourceOrderDoc: FirebaseFirestore.QueryDocumentSnapshot,
  sourcePosId: string,
  targetPosId: string,
  itemId: string
): Promise<number> {
  const db = admin.firestore();
  const itemsSnapshot = await sourceOrderDoc.ref
    .collection(COLLECTION_ITEMS)
    .get();

  const availabilityCache: Map<string, boolean> = new Map();

  const isItemTransferable = async (
    itemData: FirebaseFirestore.DocumentData
  ) => {
    const id = itemData?.id;
    if (!id) {
      return false;
    }
    if (id === itemId) {
      return true;
    }

    return await isItemGloballyAvailable(eventId, id, availabilityCache);
  };

  const itemsToTransfer: FirebaseFirestore.QueryDocumentSnapshot[] = [];
  for (const itemDoc of itemsSnapshot.docs) {
    const itemData = itemDoc.data();
    if (extractCountFromItem(itemData) <= 0) {
      continue;
    }
    if (await isItemTransferable(itemData)) {
      itemsToTransfer.push(itemDoc);
    }
  }

  if (itemsToTransfer.length === 0) {
    return 0;
  }

  const targetOrderRef = db
    .collection(COLLECTION_EVENTS)
    .doc(eventId)
    .collection(COLLECTION_POS)
    .doc(targetPosId)
    .collection(COLLECTION_ORDERS)
    .doc(sourceOrderDoc.id);

  await ensureTargetOrderDocument(targetOrderRef, sourceOrderDoc.data());

  let movedItems = 0;

  for (const itemDoc of itemsToTransfer) {
    const itemData = itemDoc.data();
    const transferCount = extractCountFromItem(itemData);
    if (transferCount <= 0) {
      await itemDoc.ref.delete();
      continue;
    }

    const targetItemRef = targetOrderRef
      .collection(COLLECTION_ITEMS)
      .doc(itemDoc.id);

    await db.runTransaction(async (transaction) => {
      const targetItemSnapshot = await transaction.get(targetItemRef);
      const existingCount = extractCountFromItem(
        targetItemSnapshot.exists ? targetItemSnapshot.data() : undefined
      );
      const newCount = existingCount + transferCount;
      const sanitizedPayload = sanitizeItemData(itemData, newCount);

      transaction.set(targetItemRef, sanitizedPayload, { merge: false });
      transaction.delete(itemDoc.ref);
    });

    movedItems += transferCount;
  }

  const remainingItemsSnapshot = await sourceOrderDoc.ref
    .collection(COLLECTION_ITEMS)
    .get();

  if (remainingItemsSnapshot.empty) {
    await sourceOrderDoc.ref.update({
      orderStatus: 'transferred',
      transferredAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  functions.logger.info('Transferred items for order', {
    eventId,
    sourcePosId,
    targetPosId,
    orderId: sourceOrderDoc.id,
    itemId,
    movedItems,
  });

  return movedItems;
}

async function transferOpenOrdersForItem(
  eventId: string,
  sourcePosId: string,
  targetPosId: string,
  itemId: string
): Promise<{ ordersAffected: number; itemsMoved: number }> {
  const db = admin.firestore();
  const sourceOrdersSnapshot = await db
    .collection(COLLECTION_EVENTS)
    .doc(eventId)
    .collection(COLLECTION_POS)
    .doc(sourcePosId)
    .collection(COLLECTION_ORDERS)
    .where('orderStatus', '==', 'open')
    .get();

  if (sourceOrdersSnapshot.empty) {
    return { ordersAffected: 0, itemsMoved: 0 };
  }

  let ordersAffected = 0;
  let totalMovedItems = 0;

  for (const orderDoc of sourceOrdersSnapshot.docs) {
    const moved = await transferItemsForOrder(
      eventId,
      orderDoc,
      sourcePosId,
      targetPosId,
      itemId
    );
    if (moved > 0) {
      ordersAffected += 1;
      totalMovedItems += moved;
    }
  }

  return { ordersAffected, itemsMoved: totalMovedItems };
}

async function syncGlobalItemAvailability(
  eventId: string,
  itemId: string
): Promise<boolean> {
  const db = admin.firestore();
  const posSnapshot = await db
    .collection(COLLECTION_EVENTS)
    .doc(eventId)
    .collection(COLLECTION_POS)
    .get();

  let isAvailableSomewhere = false;

  for (const posDoc of posSnapshot.docs) {
    const itemDoc = await posDoc.ref
      .collection(COLLECTION_ITEMS)
      .doc(itemId)
      .get();

    if (!itemDoc.exists) {
      continue;
    }

    const itemData = itemDoc.data();
    if (itemData?.isAvailable !== false) {
      isAvailableSomewhere = true;
      break;
    }
  }

  await db
    .collection(COLLECTION_EVENTS)
    .doc(eventId)
    .collection(COLLECTION_ITEMS)
    .doc(itemId)
    .set({ isAvailable: isAvailableSomewhere }, { merge: true });

  setGlobalAvailabilityCache(eventId, itemId, isAvailableSomewhere);

  return isAvailableSomewhere;
}

async function notifySoldOutOrders(
  eventId: string,
  sourcePosId: string,
  itemId: string
): Promise<void> {
  const db = admin.firestore();
  const ordersSnapshot = await db
    .collection(COLLECTION_EVENTS)
    .doc(eventId)
    .collection(COLLECTION_POS)
    .doc(sourcePosId)
    .collection(COLLECTION_ORDERS)
    .where('orderStatus', '==', 'open')
    .get();

  if (ordersSnapshot.empty) {
    return;
  }

  const availabilityCache: Map<string, boolean> = new Map();

  for (const orderDoc of ordersSnapshot.docs) {
    const orderData = orderDoc.data();
    const itemsSnapshot = await orderDoc.ref
      .collection(COLLECTION_ITEMS)
      .get();

    if (itemsSnapshot.empty) {
      continue;
    }

    const orderItems = itemsSnapshot.docs
      .map((itemDoc) => {
        const data = itemDoc.data();
        const id = data?.id;
        if (!id) {
          return null;
        }
        return { id, data };
      })
      .filter((entry): entry is { id: string; data: FirebaseFirestore.DocumentData } => !!entry);

    const uniqueItemIds = Array.from(new Set(orderItems.map((entry) => entry.id)));

    await Promise.all(
      uniqueItemIds.map(async (id) => {
        await isItemGloballyAvailable(eventId, id, availabilityCache);
      })
    );
    availabilityCache.set(itemId, false);

    const servingPoint =
      orderData.servingPointName || orderData.servingPointLocation || null;

    const soldOutEntries = orderItems.filter((entry) => {
      const available = availabilityCache.get(entry.id);
      return available === false;
    });

    if (soldOutEntries.length === 0) {
      continue;
    }

    const itemNames: Set<string> = new Set();
    let totalPrice = 0;

    for (const entry of soldOutEntries) {
      const itemData = entry.data;
      const count = extractCountFromItem(itemData);
      if (count <= 0) {
        continue;
      }

      const price = Number(itemData.price ?? 0);
      if (Number.isFinite(price) && price > 0) {
        totalPrice += price * count;
      }

      if (itemData.name) {
        itemNames.add(String(itemData.name));
      }
    }

    if (totalPrice <= 0 || itemNames.size === 0) {
      continue;
    }

    const itemIds = Array.from(
      new Set(soldOutEntries.map((entry) => entry.id))
    );
    const notificationPayload: NotificationPayload = {
      title:
        itemIds.length === 1
          ? 'Artikel ist ausverkauft'
          : 'Artikel sind ausverkauft',
      message: 'Unten stehenden Betrag erstatten und bestätigen',
      pointOfService: servingPoint || undefined,
      price: totalPrice,
      itemIds,
      orderId: orderDoc.id,
      severity: 'error',
      status: 'created',
      action: 'refund',
    };

    await createNotification(eventId, notificationPayload);

    functions.logger.info('Created order-specific sold-out notification', {
      eventId,
      itemId,
      posId: sourcePosId,
      orderId: orderDoc.id,
      refundAmount: totalPrice,
    });
  }
}

export const onPosItemAvailabilityChanged = functions
  .region('europe-west1')
  .firestore.document(
    `${COLLECTION_EVENTS}/{eventId}/${COLLECTION_POS}/{posId}/${COLLECTION_ITEMS}/{itemId}`
  )
  .onUpdate(async (change, context) => {
    const beforeData = change.before.data();
    const afterData = change.after.data();

    if (!beforeData || !afterData) {
      return null;
    }

    const eventId: string = context.params.eventId;
    const posId: string = context.params.posId;
    const itemId: string = context.params.itemId;

    const beforeAvailable =
      typeof beforeData.isAvailable === 'boolean'
        ? beforeData.isAvailable
        : true;
    const afterAvailable =
      typeof afterData.isAvailable === 'boolean' ? afterData.isAvailable : true;

    if (beforeAvailable === afterAvailable) {
      return null;
    }

    const db = admin.firestore();
    const globalItemRef = db
      .collection(COLLECTION_EVENTS)
      .doc(eventId)
      .collection(COLLECTION_ITEMS)
      .doc(itemId);

    if (afterAvailable) {
      await globalItemRef.set({ isAvailable: true }, { merge: true });
      setGlobalAvailabilityCache(eventId, itemId, true);
      await syncGlobalItemAvailability(eventId, itemId);
      functions.logger.info('Item reactivated at POS and globally', {
        eventId,
        posId,
        itemId,
      });
      return null;
    }

    functions.logger.info('Item deactivated at POS, checking availability', {
      eventId,
      posId,
      itemId,
    });

    const candidateStores = await findCandidateStores(eventId, posId, itemId);

    if (candidateStores.length === 0) {
      await globalItemRef.set({ isAvailable: false }, { merge: true });
      setGlobalAvailabilityCache(eventId, itemId, false);
      functions.logger.info(
        'No other POS offers the item. Global availability disabled.',
        {
          eventId,
          posId,
          itemId,
        }
      );

      await notifySoldOutOrders(eventId, posId, itemId);
      await syncGlobalItemAvailability(eventId, itemId);

      return null;
    }

    // Keep the global availability true if at least one other POS can sell the item
    await globalItemRef.set({ isAvailable: true }, { merge: true });
    setGlobalAvailabilityCache(eventId, itemId, true);

    const targetStore = candidateStores[0];

    const transferResult = await transferOpenOrdersForItem(
      eventId,
      posId,
      targetStore.id,
      itemId
    );

    functions.logger.info('Transfer completed', {
      eventId,
      itemId,
      fromPosId: posId,
      toPosId: targetStore.id,
      toPosName: targetStore.name,
      ordersAffected: transferResult.ordersAffected,
      itemsMoved: transferResult.itemsMoved,
    });

    await syncGlobalItemAvailability(eventId, itemId);

    return null;
  });

