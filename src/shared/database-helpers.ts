/**
 * Helper-Funktionen für Firestore-Datenbankzugriffe
 */

import * as admin from 'firebase-admin';
import { PointOfSale, Item, ServingPoint } from './types';
type ItemEntry = {
  quantity?: number;
  [key: string]: unknown;
};

type ItemWithQuantityField = Item & {
  quantity?: number;
  entries?: ItemEntry[];
  __calculatedQuantity?: number;
};

function getItemQuantity(item: Item): number {
  const itemWithQuantity = item as ItemWithQuantityField;

  if (
    typeof itemWithQuantity.__calculatedQuantity === 'number' &&
    Number.isFinite(itemWithQuantity.__calculatedQuantity)
  ) {
    return Math.max(0, Math.floor(itemWithQuantity.__calculatedQuantity));
  }

  let entriesQuantity: number | undefined;
  if (Array.isArray(itemWithQuantity.entries)) {
    const sum = itemWithQuantity.entries.reduce((accumulator, entry) => {
      const value = Number(entry?.quantity ?? 0);
      if (!Number.isFinite(value) || value <= 0) {
        return accumulator;
      }
      return accumulator + Math.floor(value);
    }, 0);
    entriesQuantity = sum > 0 ? sum : undefined;
  }

  const rawValue =
    itemWithQuantity.quantity ??
    entriesQuantity ??
    itemWithQuantity.count ??
    1;

  const numericValue = Number(rawValue);

  if (!Number.isFinite(numericValue)) {
    return 1;
  }

  if (numericValue <= 0) {
    return 0;
  }

  return Math.floor(numericValue);
}


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
  console.log(`Loading Points of Sale for event ${eventId}...`);
  
  const posSnapshot = await admin
    .firestore()
    .collection(COLLECTION_EVENTS)
    .doc(eventId)
    .collection(COLLECTION_POS)
    .get();

  console.log(`Found ${posSnapshot.size} Points of Sale documents`);

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

    console.log(`Store ${posId} (${posData.name || 'no name'}): ${itemsSnapshot.size} available items`);
    if (itemsSnapshot.size > 0) {
      const itemIds = itemsSnapshot.docs.map(doc => {
        const itemData = doc.data();
        return itemData.id || doc.id;
      }).join(', ');
      console.log(`  Item IDs: ${itemIds}`);
    }

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

  console.log(`Returned ${pointsOfSale.length} Points of Sale with items`);
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
  const groupedItems: Map<string, { item: ItemWithQuantityField; count: number }> = new Map();
  for (const rawItem of items as ItemWithQuantityField[]) {
    const item = rawItem as ItemWithQuantityField;
    const key = `${item.id}_${(item.selectedExtras || []).join(',')}_${(item.excludedIngredients || []).join(',')}`;
    const existing = groupedItems.get(key);
    const quantity = getItemQuantity(item);

    if (quantity === 0) {
      continue;
    }

    if (existing) {
      existing.count += quantity;
      existing.item.count = existing.count;
      existing.item.__calculatedQuantity = existing.count;
    } else {
      const normalizedItem: ItemWithQuantityField = {
        ...item,
        count: quantity,
        __calculatedQuantity: quantity,
      };
      groupedItems.set(key, { item: normalizedItem, count: quantity });
    }
  }

  // Speichere jedes Item mit seinen Extras und excludedIngredients (ein Dokument pro Kombination)
  for (const [docId, { item, count }] of groupedItems.entries()) {
    const itemRef = itemsCollectionRef.doc(docId);

    batch.set(itemRef, {
      itemId: item.id,
      name: item.name || null,
      price: item.price || null,
      quantity: count,
      category: item.category || null,
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
    servingPointId: purchase.servingPoint?.id || null,
    orderPlaced: purchase.orderPlaced
      ? admin.firestore.Timestamp.fromDate(purchase.orderPlaced)
      : admin.firestore.FieldValue.serverTimestamp(),
    userId: purchase.userId || null,
    note: purchase.note || null,
  });

  // Gruppiere Items nach ID für die Items-Collection
  const itemQuantities: Map<string, number> = new Map();
  for (const item of purchase.items) {
    const quantity = getItemQuantity(item);

    if (quantity === 0) {
      continue;
    }

    itemQuantities.set(
      item.id,
      (itemQuantities.get(item.id) || 0) + quantity
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

