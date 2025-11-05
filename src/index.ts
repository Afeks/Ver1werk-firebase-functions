/**
 * Firebase Functions Entry Point
 * Exportiert alle Callable Functions für OrderCat
 */

import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { distributeOrder } from './distribute-order';
import { DistributeOrderRequest, DistributeOrderResponse } from './types';

// Exportiere den Firestore Trigger
export { onPurchaseCreated } from './trigger-order-distribution';

// Initialisiere Firebase Admin (nur einmal)
if (!admin.apps.length) {
  admin.initializeApp();
}

/**
 * Callable Function: distributeOrder
 * 
 * Verteilt eine Bestellung auf verschiedene Points of Sale basierend auf dem DistributionMode.
 * 
 * Request Body:
 * {
 *   eventId: string,
 *   items: Item[],
 *   servingPoint: ServingPoint,
 *   userId?: string,
 *   distributionMode?: 'balanced' | 'grouped',
 *   note?: string
 * }
 * 
 * Response:
 * {
 *   success: boolean,
 *   purchaseId: string,
 *   distributedPurchases: Array<{
 *     pointOfSaleId: string,
 *     pointOfSaleName: string,
 *     orderId: string,
 *     itemsCount: number
 *   }>,
 *   error?: string
 * }
 */
export const distributeOrderFunction = functions
  .region('europe-west1') // Wähle die passende Region
  .https.onCall(
    async (
      data: DistributeOrderRequest,
      context
    ): Promise<DistributeOrderResponse> => {
      // Authentifizierung prüfen (optional - entfernen falls nicht benötigt)
      if (!context.auth) {
        throw new functions.https.HttpsError(
          'unauthenticated',
          'The function must be called while authenticated.'
        );
      }

      // Validierung der Eingabedaten
      if (!data.eventId || !data.items || !data.servingPoint) {
        throw new functions.https.HttpsError(
          'invalid-argument',
          'Missing required fields: eventId, items, or servingPoint'
        );
      }

      // Rufe die Verteilungslogik auf
      const result = await distributeOrder(data);

      if (!result.success) {
        throw new functions.https.HttpsError(
          'internal',
          result.error || 'Failed to distribute order'
        );
      }

      return result;
    }
  );

