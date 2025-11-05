/**
 * Helper-Funktionen für Firestore-Datenbankzugriffe
 */

import * as admin from 'firebase-admin';
import { PointOfSale, Item, ServingPoint } from './types';

const COLLECTION_EVENTS = 'Events';
const COLLECTION_POS = 'Points-of-Sale';
const COLLECTION_ORDERS = 'Orders';
const COLLECTION_ITEMS = 'Items';

/**
 * Zählt die Anzahl offener Bestellungen für einen Point of Sale
 */
export async function countOpenOrdersForStore(
  storeId: string,
  eventId: string
): Promise<number> {
  const ordersSnapshot = await admin
    .firestore()
    .collection(COLLECTION_EVENTS)
    .doc(eventId)
    .collection(COLLECTION_POS)
    .doc(storeId)
    .collection(COLLECTION_ORDERS)
    .where('orderStatus', '==', 'open')
    .get();

  return ordersSnapshot.size;
}

/**
 * Holt alle Points of Sale für ein Event mit ihren verfügbaren Items
 */
export async function getPointsOfSaleFromEvent(
  eventId: string
): Promise<PointOfSale[]> {
  const posSnapshot = await admin
    .firestore()
    .collection(COLLECTION_EVENTS)
    .doc(eventId)
    .collection(COLLECTION_POS)
    .get();

  const pointsOfSale: PointOfSale[] = [];

  for (const posDoc of posSnapshot.docs) {
    const posData = posDoc.data();
    const posId = posData.id || posDoc.id;

    // Hole verfügbare Items für diesen Point of Sale
    const itemsSnapshot = await admin
      .firestore()
      .collection(COLLECTION_EVENTS)
      .doc(eventId)
      .collection(COLLECTION_POS)
      .doc(posId)
      .collection(COLLECTION_ITEMS)
      .get();

    const availableItems: Item[] = itemsSnapshot.docs.map((itemDoc) => {
      const itemData = itemDoc.data();
      return {
        id: itemData.id || itemDoc.id,
        name: itemData.name,
        price: itemData.price,
        count: itemData.count,
        category: itemData.category,
        categoryName: itemData.categoryName,
        soldOut: itemData.soldOut || false,
        isAvailable: itemData.isAvailable !== false, // Default true
        selectedExtras: itemData.selectedExtras || [],
        excludedIngredients: itemData.excludedIngredients || [],
      };
    });

    pointsOfSale.push({
      id: posId,
      name: posData.name || '',
      description: posData.description,
      location: posData.location || '',
      availableItems: availableItems,
    });
  }

  return pointsOfSale;
}

/**
 * Erstellt eine verteilte Bestellung für einen Point of Sale
 */
export async function createDistributedPurchaseForPointOfSale(
  items: Item[],
  store: PointOfSale,
  eventId: string,
  servingPoint: ServingPoint,
  originalOrderId: string,
  note?: string
): Promise<void> {
  const db = admin.firestore();
  const batch = db.batch();

  const orderRef = db
    .collection(COLLECTION_EVENTS)
    .doc(eventId)
    .collection(COLLECTION_POS)
    .doc(store.id)
    .collection(COLLECTION_ORDERS)
    .doc(originalOrderId);

  const itemsCollectionRef = orderRef.collection(COLLECTION_ITEMS);

  // Gruppiere Items nach ID, selectedExtras und excludedIngredients
  const itemCounts: Map<string, number> = new Map();
  for (const item of items) {
    const uniqueKey = `${item.id}_${(item.selectedExtras || []).join(',')}_${(item.excludedIngredients || []).join(',')}`;
    itemCounts.set(uniqueKey, (itemCounts.get(uniqueKey) || 0) + 1);
  }

  // Speichere jedes Item mit seinen Extras und excludedIngredients
  for (const item of items) {
    const docId = `${item.id}_${(item.selectedExtras || []).join(',')}_${(item.excludedIngredients || []).join(',')}`;
    const itemRef = itemsCollectionRef.doc(docId);

    batch.set(itemRef, {
      id: item.id,
      name: item.name,
      price: item.price,
      count: itemCounts.get(docId) || 1,
      selectedExtras: item.selectedExtras || [],
      excludedIngredients: item.excludedIngredients || [],
    });
  }

  // Erstelle das Order-Dokument
  batch.set(orderRef, {
    id: originalOrderId,
    orderDate: admin.firestore.FieldValue.serverTimestamp(),
    orderStatus: 'open',
    servingPointName: servingPoint.name,
    servingPointLocation: servingPoint.location,
    note: note || null,
  });

  await batch.commit();
}

/**
 * Erstellt eine Hauptbestellung (Purchase)
 */
export async function createPurchase(
  purchase: {
    id: string;
    items: Item[];
    eventId: string;
    userId?: string;
    servingPoint?: ServingPoint;
    orderStatus?: string;
    orderPlaced?: Date;
    note?: string;
  }
): Promise<void> {
  const db = admin.firestore();
  const purchaseRef = db
    .collection(COLLECTION_EVENTS)
    .doc(purchase.eventId)
    .collection(COLLECTION_ORDERS)
    .doc(purchase.id);

  const batch = db.batch();

  // Erstelle das Purchase-Dokument
  batch.set(purchaseRef, {
    tableId: purchase.servingPoint?.id || null,
    orderPlaced: purchase.orderPlaced
      ? admin.firestore.Timestamp.fromDate(purchase.orderPlaced)
      : admin.firestore.FieldValue.serverTimestamp(),
    userId: purchase.userId || null,
    note: purchase.note || null,
  });

  // Gruppiere Items nach ID für die Items-Collection
  const itemQuantities: Map<string, number> = new Map();
  for (const item of purchase.items) {
    itemQuantities.set(
      item.id,
      (itemQuantities.get(item.id) || 0) + 1
    );
  }

  // Speichere Items in der Items-Collection
  for (const [itemId, quantity] of itemQuantities.entries()) {
    if (itemId) {
      const itemRef = purchaseRef.collection(COLLECTION_ITEMS).doc(itemId);
      batch.set(itemRef, {
        itemId: itemId,
        quantity: quantity,
      });
    }
  }

  await batch.commit();
}

