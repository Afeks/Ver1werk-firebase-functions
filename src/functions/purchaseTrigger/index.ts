/**
 * Firestore Trigger Function
 * Wird automatisch ausgelöst, wenn eine neue Hauptbestellung (Purchase) erstellt wird
 */

import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { distributeOrderWithoutPurchase } from '../../shared/distribute-order';
import {
  DistributionMode,
  Item,
  ServingPoint,
} from '../../shared/types';

const COLLECTION_EVENTS = 'Events';
const COLLECTION_ORDERS = 'Orders';
const COLLECTION_ITEMS = 'Items';
const COLLECTION_SERVING_POINTS = 'Serving-Points';

/**
 * Läd ein ServingPoint aus Firestore
 */
async function getServingPointById(
  eventId: string,
  servingPointId: string
): Promise<ServingPoint | null> {
  try {
    const servingPointDoc = await admin
      .firestore()
      .collection(COLLECTION_EVENTS)
      .doc(eventId)
      .collection(COLLECTION_SERVING_POINTS)
      .doc(servingPointId)
      .get();

    if (!servingPointDoc.exists) {
      return null;
    }

    const data = servingPointDoc.data()!;
    return {
      id: servingPointDoc.id,
      name: data.name || '',
      location: data.location || '',
      areaName: data.areaName,
      capacity: data.capacity || 0,
    };
  } catch (error) {
    console.error('Error loading serving point:', error);
    return null;
  }
}

/**
 * Läd vollständige Item-Daten aus der globalen Items-Collection
 */
async function getItemDetails(
  eventId: string,
  itemId: string
): Promise<Item | null> {
  try {
    const itemDoc = await admin
      .firestore()
      .collection(COLLECTION_EVENTS)
      .doc(eventId)
      .collection(COLLECTION_ITEMS)
      .doc(itemId)
      .get();

    if (!itemDoc.exists) {
      return null;
    }

    const data = itemDoc.data()!;
    return {
      id: itemDoc.id,
      name: data.name,
      price: data.price,
      count: data.count,
      category: data.category,
      categoryName: data.categoryName,
      soldOut: data.soldOut || false,
      isAvailable: data.isAvailable !== false,
      selectedExtras: data.selectedExtras || [],
      excludedIngredients: data.excludedIngredients || [],
    };
  } catch (error) {
    console.error('Error loading item details:', error);
    return null;
  }
}

/**
 * Läd Items aus der Purchase Items Sub-Collection
 * und erweitert sie mit vollständigen Item-Details
 * 
 * Die Purchase Items Sub-Collection speichert jetzt auch selectedExtras und excludedIngredients
 */
async function loadPurchaseItems(
  eventId: string,
  purchaseId: string
): Promise<Item[]> {
  const itemsSnapshot = await admin
    .firestore()
    .collection(COLLECTION_EVENTS)
    .doc(eventId)
    .collection(COLLECTION_ORDERS)
    .doc(purchaseId)
    .collection(COLLECTION_ITEMS)
    .get();

  const items: Item[] = [];

  for (const itemDoc of itemsSnapshot.docs) {
    const itemData = itemDoc.data();
    const itemId = itemData.itemId || itemDoc.id;
    const quantity = itemData.quantity || 1;
    const selectedExtras = itemData.selectedExtras || [];
    const excludedIngredients = itemData.excludedIngredients || [];

    // Lade vollständige Item-Details aus der globalen Items-Collection
    const itemDetails = await getItemDetails(eventId, itemId);

    if (itemDetails) {
      // Erstelle ein Item für jede Quantity mit Extras/Ingredients
      for (let i = 0; i < quantity; i++) {
        items.push({
          ...itemDetails,
          id: itemId,
          selectedExtras: selectedExtras,
          excludedIngredients: excludedIngredients,
        });
      }
    } else {
      // Fallback falls Item-Details nicht gefunden werden
      console.warn(`Item details not found for itemId: ${itemId}`);
      items.push({
        id: itemId,
        name: itemData.name || 'Unknown Item',
        price: itemData.price || 0,
        count: quantity,
        category: itemData.category,
        categoryName: itemData.categoryName,
        selectedExtras: selectedExtras,
        excludedIngredients: excludedIngredients,
      });
    }
  }

  return items;
}

/**
 * Läd den DistributionMode aus dem Event
 */
async function getDistributionMode(eventId: string): Promise<DistributionMode> {
  try {
    const eventDoc = await admin
      .firestore()
      .collection(COLLECTION_EVENTS)
      .doc(eventId)
      .get();

    if (!eventDoc.exists) {
      return DistributionMode.BALANCED; // Default
    }

    const data = eventDoc.data()!;
    const mode = data.distributionMode;

    if (mode === 'grouped') {
      return DistributionMode.GROUPED;
    }

    return DistributionMode.BALANCED; // Default
  } catch (error) {
    console.error('Error loading distribution mode:', error);
    return DistributionMode.BALANCED; // Default
  }
}

/**
 * Firestore Trigger: Wird ausgelöst, wenn eine Purchase erstellt oder aktualisiert wird
 * und erstmals den Status "isPaid = true" erhält.
 * 
 * Pfad: Events/{eventId}/Orders/{purchaseId}
 */
export const onPurchaseCreated = functions
  .region('europe-west1')
  .firestore.document(`${COLLECTION_EVENTS}/{eventId}/${COLLECTION_ORDERS}/{purchaseId}`)
  .onWrite(async (change, context) => {
    const beforeData = change.before.exists ? change.before.data() : undefined;
    const purchaseData = change.after.exists ? change.after.data() : undefined;
    const eventId = context.params.eventId;
    const purchaseId = context.params.purchaseId;

    if (!purchaseData) {
      console.log(`Purchase ${purchaseId} for event ${eventId} was deleted. Skipping.`);
      return null;
    }

    const wasPaidBefore = beforeData?.isPaid === true;
    const isPaidNow = purchaseData.isPaid === true;

    if (!isPaidNow) {
      console.log(`Purchase ${purchaseId} for event ${eventId} is not paid yet. Waiting.`);
      return null;
    }

    if (wasPaidBefore) {
      console.log(`Purchase ${purchaseId} for event ${eventId} was already processed when paid. Skipping.`);
      return null;
    }

    console.log(`Purchase ${purchaseId} for event ${eventId} marked as paid. Starting distribution.`);

    try {
      // Prüfe ob bereits verteilt wurde (verhindert Re-Triggering)
      if (purchaseData.distributed) {
        console.log(`Purchase ${purchaseId} already distributed, skipping`);
        return null;
      }

      // Lade ServingPoint
      const servingPointId = purchaseData.servingPointId;
      if (!servingPointId) {
        console.error(`No servingPointId found for purchase ${purchaseId}`);
        return null;
      }

      const servingPoint = await getServingPointById(eventId, servingPointId);
      if (!servingPoint) {
        console.error(`ServingPoint ${servingPointId} not found for event ${eventId}`);
        return null;
      }

      // Lade Items aus der Purchase Items Sub-Collection
      const items = await loadPurchaseItems(eventId, purchaseId);
      console.log(`Loaded ${items.length} items from purchase ${purchaseId}`);
      if (items.length === 0) {
        console.error(`No items found for purchase ${purchaseId}`);
        return null;
      }
      console.log(`Items to distribute: ${items.map(i => i.id).join(', ')}`);

      // Lade DistributionMode aus dem Event
      const distributionMode = await getDistributionMode(eventId);
      console.log(`DistributionMode: ${distributionMode}`);

      // Rufe distributeOrderWithoutPurchase auf (Purchase existiert bereits)
      console.log(`Starting distribution...`);
      const result = await distributeOrderWithoutPurchase(
        purchaseId,
        eventId,
        items,
        servingPoint,
        distributionMode,
        purchaseData.note
      );

      console.log(`Distribution result - success: ${result.success}, distributedPurchases: ${result.distributedPurchases.length}, error: ${result.error || 'none'}`);

      if (result.success) {
        // Markiere Purchase als verteilt
        await change.after.ref.update({
          distributed: true,
          distributedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        console.log(
          `Successfully distributed purchase ${purchaseId} to ${result.distributedPurchases.length} points of sale`
        );
      } else {
        console.error(
          `Failed to distribute purchase ${purchaseId}: ${result.error}`
        );
      }

      return result;
    } catch (error: any) {
      console.error(`Error processing purchase ${purchaseId}:`, error);
      // Optional: Markiere als fehlgeschlagen
      try {
        await change.after.ref.update({
          distributionError: error.message,
          distributionFailed: true,
        });
      } catch (updateError) {
        console.error('Failed to update purchase with error:', updateError);
      }
      throw error;
    }
  });

