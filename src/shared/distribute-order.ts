/**
 * Hauptfunktion zur Verteilung von Bestellungen auf Points of Sale
 * Implementiert die gleiche Logik wie order_page_controller.dart
 */

import {
  DistributionMode,
  Item,
  PointOfSale,
  ServingPoint,
  DistributeOrderRequest,
  DistributeOrderResponse,
} from './types';
import {
  countOpenOrdersForStore,
  getPointsOfSaleFromEvent,
  createDistributedPurchaseForPointOfSale,
  createPurchase,
} from './database-helpers';
import { v4 as uuidv4 } from 'uuid';

/**
 * Verteilt Items auf Points of Sale basierend auf dem DistributionMode
 */
type ItemEntry = {
  quantity?: number;
  [key: string]: unknown;
};

type ItemWithQuantityField = Item & {
  quantity?: number;
  entries?: ItemEntry[];
};

function getItemQuantity(item: Item): number {
  const itemWithQuantity = item as ItemWithQuantityField;

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

async function distributeItems(
  itemList: Item[],
  pointsOfSale: PointOfSale[],
  distributionMode: DistributionMode,
  servingPoint: ServingPoint,
  originalOrderId: string,
  eventId: string,
  note?: string
): Promise<{
  pointOfSaleId: string;
  pointOfSaleName: string;
  orderId: string;
  itemsCount: number;
}[]> {
  const distributedPurchases: {
    pointOfSaleId: string;
    pointOfSaleName: string;
    orderId: string;
    itemsCount: number;
  }[] = [];

  if (distributionMode === DistributionMode.BALANCED) {
    // Map, um Items pro Store zu gruppieren
    const storeOrdersMap: Map<PointOfSale, ItemWithQuantityField[]> = new Map();

    console.log(
      `Starting distribution of ${itemList.length} items to ${pointsOfSale.length} stores`
    );

    for (const item of itemList) {
      const quantity = getItemQuantity(item);
      console.log(
        `Processing item: ${item.id} (${item.name || 'no name'}) with quantity ${quantity}`
      );

      if (quantity <= 0) {
        console.warn(
          `Skipping item ${item.id} (${item.name || 'no name'}) with non-positive quantity ${quantity}`
        );
        continue;
      }

      const normalizedItem: ItemWithQuantityField = {
        ...item,
        count: quantity,
        quantity: quantity,
      };
      
      // Finde Stores, die dieses Item verfügbar haben
      const availableStores = pointsOfSale.filter((store) => {
        return store.availableItems.some(
          (availableItem) => availableItem.id === item.id
        );
      });

      console.log(`Item ${item.id} available in ${availableStores.length} stores`);

      if (availableStores.length > 0) {
        // Erstelle eine Liste, die Stores und ihre offenen Bestellungen enthält
        const storesWithOpenOrders: Array<{ store: PointOfSale; count: number }> =
          [];

        for (const store of availableStores) {
          // Hole die Anzahl offener Bestellungen für jeden Store
          const openOrdersCount = await countOpenOrdersForStore(
            store.id,
            eventId
          );
          storesWithOpenOrders.push({ store, count: openOrdersCount });
        }

        // Sortiere die Liste der Stores basierend auf der Anzahl offener Bestellungen
        storesWithOpenOrders.sort((a, b) => a.count - b.count);

        // Wähle den Store mit der geringsten Auslastung (der erste Store in der Liste)
        const leastBusyStore = storesWithOpenOrders[0].store;
        console.log(`Selected store for item ${item.id}: ${leastBusyStore.name} (${leastBusyStore.id}) with ${storesWithOpenOrders[0].count} open orders`);

        // Füge das Item zum Store in der Map hinzu
        if (!storeOrdersMap.has(leastBusyStore)) {
          storeOrdersMap.set(leastBusyStore, []);
        }
        storeOrdersMap.get(leastBusyStore)!.push(normalizedItem);
      } else {
        console.warn(`WARNING: Item ${item.id} (${item.name || 'no name'}) is not available in any store!`);
      }
    }

    console.log(`Created ${storeOrdersMap.size} store orders`);

    // Für jeden Store eine Bestellung erstellen, die alle Items zusammenfasst
    for (const [store, itemsForStore] of storeOrdersMap.entries()) {
      const totalQuantityForStore = itemsForStore.reduce(
        (sum, currentItem) => sum + getItemQuantity(currentItem),
        0
      );

      console.log(
        `Creating order for store ${store.name} with ${totalQuantityForStore} items`
      );
      // Erstelle eine Bestellung mit den Items für den Store und der ursprünglichen Bestell-ID
      await createDistributedPurchaseForPointOfSale(
        itemsForStore,
        store,
        eventId,
        servingPoint,
        originalOrderId,
        note
      );

      distributedPurchases.push({
        pointOfSaleId: store.id,
        pointOfSaleName: store.name,
        orderId: originalOrderId,
        itemsCount: totalQuantityForStore,
      });
      console.log(`Created distributed purchase for store ${store.name}`);
    }

    console.log(`Distribution completed. Total distributed purchases: ${distributedPurchases.length}`);
  } else if (distributionMode === DistributionMode.GROUPED) {
    // TODO: Implementiere den grouped-Modus wenn nötig
    // Siehe auskommentierte Logik in order_page_controller.dart
    throw new Error('Grouped distribution mode not yet implemented');
  } else {
    throw new Error(`Unknown distribution mode: ${distributionMode}`);
  }

  return distributedPurchases;
}

/**
 * Hauptfunktion zur Verteilung einer Bestellung
 * Erstellt eine neue Purchase und verteilt sie
 */
export async function distributeOrder(
  request: DistributeOrderRequest
): Promise<DistributeOrderResponse> {
  try {
    const {
      eventId,
      items,
      servingPoint,
      userId,
      distributionMode = DistributionMode.BALANCED,
      note,
    } = request;

    // Validierung
    if (!eventId || !items || items.length === 0 || !servingPoint) {
      return {
        success: false,
        purchaseId: '',
        distributedPurchases: [],
        error: 'Missing required fields: eventId, items, or servingPoint',
      };
    }

    // Generiere eine eindeutige ID für die Hauptbestellung
    const purchaseId = uuidv4();

    // Erstelle zuerst die ursprüngliche Bestellung (Purchase)
    await createPurchase({
      id: purchaseId,
      items: items,
      eventId: eventId,
      userId: userId,
      servingPoint: servingPoint,
      orderStatus: 'open',
      orderPlaced: new Date(),
      note: note,
    });

    // Verteile die Bestellung
    return await distributeOrderWithoutPurchase(
      purchaseId,
      eventId,
      items,
      servingPoint,
      distributionMode,
      note
    );
  } catch (error: any) {
    console.error('Error distributing order:', error);
    return {
      success: false,
      purchaseId: '',
      distributedPurchases: [],
      error: error.message || 'Unknown error occurred',
    };
  }
}

/**
 * Verteilt eine bereits bestehende Purchase
 * Wird vom Firestore Trigger verwendet
 */
export async function distributeOrderWithoutPurchase(
  purchaseId: string,
  eventId: string,
  items: Item[],
  servingPoint: ServingPoint,
  distributionMode: DistributionMode,
  note?: string
): Promise<DistributeOrderResponse> {
  try {
    // Validierung
    if (!eventId || !items || items.length === 0 || !servingPoint || !purchaseId) {
      return {
        success: false,
        purchaseId: purchaseId,
        distributedPurchases: [],
        error: 'Missing required fields',
      };
    }

    // Hole alle Points of Sale für das Event
    console.log(`Loading Points of Sale for event ${eventId}...`);
    const eventStores = await getPointsOfSaleFromEvent(eventId);
    console.log(`Found ${eventStores.length} Points of Sale`);

    if (eventStores.length === 0) {
      console.error(`No Points of Sale found for event ${eventId}`);
      return {
        success: false,
        purchaseId: purchaseId,
        distributedPurchases: [],
        error: 'No Points of Sale found for this event',
      };
    }

    // Logge verfügbare Items pro Store
    eventStores.forEach(store => {
      console.log(`Store: ${store.name} (${store.id}), Available items: ${store.availableItems.length}`);
      if (store.availableItems.length > 0) {
        console.log(`  Item IDs: ${store.availableItems.map(i => i.id).join(', ')}`);
      }
    });

    // Logge Items die verteilt werden sollen
    console.log(`Items to distribute: ${items.map(i => i.id).join(', ')}`);

    // Verteile die Items mit der ursprünglichen Bestell-ID
    console.log(`Starting item distribution...`);
    const distributedPurchases = await distributeItems(
      items,
      eventStores,
      distributionMode,
      servingPoint,
      purchaseId,
      eventId,
      note
    );

    return {
      success: true,
      purchaseId: purchaseId,
      distributedPurchases: distributedPurchases,
    };
  } catch (error: any) {
    console.error('Error distributing order:', error);
    return {
      success: false,
      purchaseId: purchaseId,
      distributedPurchases: [],
      error: error.message || 'Unknown error occurred',
    };
  }
}

