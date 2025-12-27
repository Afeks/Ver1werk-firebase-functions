/**
 * Callable Function: distributeOrder
 * 
 * Verteilt eine Bestellung auf verschiedene Points of Sale basierend auf dem DistributionMode.
 */

import * as functions from 'firebase-functions';
import { distributeOrder } from '../../shared/distribute-order';
import { DistributeOrderRequest, DistributeOrderResponse } from '../../shared/types';

export const distributeOrderFunction = functions
  .region('europe-west1')
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

